import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as sinon from 'sinon';

import Cache from '../../lib/cache.js';
import { FailureAggregator } from '../../lib/ci/failure_aggregator.js';

const source = 'https://github.com/nodejs/node/pull/123/';
const otherSource = 'https://github.com/nodejs/node/pull/456/';

function filesGenerator(files, error) {
  return async function * () {
    if (error) {
      throw error;
    }
    yield * files;
  };
}

function makeFailure(file, overrides = {}) {
  return {
    type: 'JS_TEST_FAILURE',
    file,
    source,
    upstream: 'https://ci.nodejs.org/job/node-test-pull-request/123/',
    url: 'https://ci.nodejs.org/job/node-test-commit-linux/123/console',
    builtOn: 'test-machine',
    reason: `not ok 1 ${file}`,
    highlight: 0,
    revision: 'abc123',
    ...overrides
  };
}

describe('FailureAggregator', () => {
  it('excludes failures for test files modified by the PR', async() => {
    const cli = { warn: sinon.stub() };
    const request = {
      getPullRequestFiles: sinon.stub().callsFake(({ prid }) => {
        const files = prid === 123
          ? [
              { filename: 'test/parallel/test-modified.js' },
              { filename: 'test/parallel/test-module.mjs' },
              {
                filename: 'test/parallel/test-renamed.js',
                previous_filename: 'test/parallel/test-old-name.cjs'
              },
              { filename: 'lib/internal/example.js' }
            ]
          : [];
        return filesGenerator(files)();
      })
    };
    const kept = makeFailure('parallel/test-kept');
    const nonTestFailure = makeFailure(undefined, { type: 'BUILD_FAILURE' });
    const companions = [
      makeFailure('parallel/test-modified', { source: otherSource }),
      makeFailure('parallel/test-module', { source: otherSource }),
      makeFailure('parallel/test-old-name', { source: otherSource })
    ];
    const aggregator = new FailureAggregator(cli, [
      {},
      makeFailure('parallel/test-modified'),
      makeFailure('parallel/test-module'),
      makeFailure('parallel/test-old-name'),
      ...companions,
      kept,
      nonTestFailure
    ]);

    const failures = await aggregator.filterPRModifiedTests(request);

    assert.deepStrictEqual(failures, [...companions, kept, nonTestFailure]);
    assert.deepStrictEqual(request.getPullRequestFiles.firstCall.args[0], {
      owner: 'nodejs',
      repo: 'node',
      prid: 123
    });
    assert.strictEqual(request.getPullRequestFiles.callCount, 2);
    assert.strictEqual(cli.warn.callCount, 0);
  });

  it('removes a modified-test occurrence from the flaky PR count', async() => {
    const cli = { warn: sinon.stub() };
    const request = {
      getPullRequestFiles: sinon.stub().callsFake(({ prid }) => {
        const files = prid === 123
          ? [{ filename: 'test/ffi/test-ffi-fast-buffer.js' }]
          : [];
        return filesGenerator(files)();
      })
    };
    const reason = 'not ok 1 ffi/test-ffi-fast-buffer';
    const modified = makeFailure('ffi/test-ffi-fast-buffer', { reason });
    const flaky = makeFailure('ffi/test-ffi-fast-buffer', {
      source: 'https://github.com/nodejs/node/pull/456/',
      upstream: 'https://ci.nodejs.org/job/node-test-pull-request/456/',
      reason
    });
    const aggregator = new FailureAggregator(cli, [{}, modified, flaky]);

    await aggregator.filterPRModifiedTests(request);
    const aggregates = aggregator.aggregate();

    assert.deepStrictEqual(
      aggregates.JS_TEST_FAILURE[0].prs.map(({ source }) => source),
      ['https://github.com/nodejs/node/pull/456/']
    );
  });

  it('keeps failures when modified files cannot be fetched', async() => {
    const cli = { warn: sinon.stub() };
    const request = {
      getPullRequestFiles: sinon.stub().callsFake(
        filesGenerator([], new Error('GitHub unavailable')))
    };
    const failure = makeFailure('parallel/test-modified');
    const companion = makeFailure('parallel/test-modified', {
      source: otherSource
    });
    const aggregator = new FailureAggregator(cli, [{}, failure, companion]);

    const failures = await aggregator.filterPRModifiedTests(request);

    assert.deepStrictEqual(failures, [failure, companion]);
    assert.strictEqual(cli.warn.callCount, 2);
  });

  it('caches files by PR revision', async(t) => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncu-pr-files-'));
    t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
    const cache = new Cache(cacheDir);
    cache.enable();
    const cli = { warn: sinon.stub() };
    const request = {
      getPullRequestFiles: sinon.stub().callsFake(({ prid }) => {
        const files = prid === 123
          ? [{ filename: 'test/parallel/test-modified.js' }]
          : [];
        return filesGenerator(files)();
      })
    };
    const makeData = (revision) => [
      {},
      makeFailure('parallel/test-modified', { revision }),
      makeFailure('parallel/test-modified', {
        source: otherSource,
        revision
      })
    ];

    const first = new FailureAggregator(cli, makeData('abc123'));
    await first.filterPRModifiedTests(request, cache);
    assert.strictEqual(request.getPullRequestFiles.callCount, 2);

    const second = new FailureAggregator(cli, makeData('abc123'));
    await second.filterPRModifiedTests(request, cache);
    assert.strictEqual(request.getPullRequestFiles.callCount, 2);

    const updated = new FailureAggregator(cli, makeData('def456'));
    await updated.filterPRModifiedTests(request, cache);
    assert.strictEqual(request.getPullRequestFiles.callCount, 4);
  });

  it('generates markdown when all failures are excluded', async() => {
    const cli = { warn: sinon.stub() };
    const request = {
      getPullRequestFiles: sinon.stub().callsFake(filesGenerator([
        { filename: 'test/parallel/test-modified.js' }
      ]))
    };
    const failure = makeFailure('parallel/test-modified');
    const companion = makeFailure('parallel/test-modified', {
      source: otherSource
    });
    const health = { formatAsMarkdown: () => 'CI health' };
    const aggregator = new FailureAggregator(cli, [health, failure, companion]);

    await aggregator.filterPRModifiedTests(request);
    aggregator.aggregate();

    const markdown = aggregator.formatAsMarkdown();
    assert.match(markdown, /CI health/);
    assert.doesNotMatch(markdown, /test-modified/);
  });

  it('does not fetch files for singleton failures', async() => {
    const cli = { warn: sinon.stub() };
    const request = { getPullRequestFiles: sinon.stub() };
    const failure = makeFailure('parallel/test-singleton');
    const aggregator = new FailureAggregator(cli, [{}, failure]);

    const failures = await aggregator.filterPRModifiedTests(request);

    assert.deepStrictEqual(failures, [failure]);
    assert.strictEqual(request.getPullRequestFiles.callCount, 0);
  });

  it('does not fetch files for non-PR failures', async() => {
    const cli = { warn: sinon.stub() };
    const request = { getPullRequestFiles: sinon.stub() };
    const failure = makeFailure('parallel/test-failure', {
      source: 'https://api.github.com/repos/nodejs/node/git/refs/heads/main'
    });
    const aggregator = new FailureAggregator(cli, [{}, failure]);

    const failures = await aggregator.filterPRModifiedTests(request);

    assert.deepStrictEqual(failures, [failure]);
    assert.strictEqual(request.getPullRequestFiles.callCount, 0);
  });
});
