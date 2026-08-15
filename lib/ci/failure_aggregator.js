import chalk from 'chalk';
import os from 'node:os';
import path from 'node:path';

import { getMachineUrl, parsePRFromURL } from '../links.js';
import Cache from '../cache.js';
import CIFailureParser from './ci_failure_parser.js';
import {
  parseJobFromURL,
  CI_TYPES
} from './ci_type_parser.js';
import {
  fold,
  getHighlight,
  markdownRow
} from './ci_utils.js';

const { FAILURE_TYPES_NAME } = CIFailureParser;
const { JS_TEST_FAILURE } = CIFailureParser.FAILURE_TYPES;

export const prFilesCache = new Cache(
  path.join(os.tmpdir(), 'ncu', 'cache', 'github-pr-files'));

function normalizeTestPath(file) {
  const normalized = file.replaceAll('\\', '/');
  const path = normalized.startsWith('test/')
    ? normalized
    : `test/${normalized}`;
  return path.replace(/\.(?:c|m)?js$/, '');
}

function uniqBy(array, key) {
  const seen = new Set();
  return array.filter((item) => !seen.has(item[key]) && seen.add(item[key]));
}

export class FailureAggregator {
  constructor(cli, data) {
    this.cli = cli;
    this.health = data[0];
    this.failures = data.slice(1);
    this.unfilteredFailures = this.failures;
    this.aggregates = null;
  }

  async getPullRequestFiles(request, pr, revision, cache) {
    const cacheKey = revision
      ? `${pr.owner}-${pr.repo}-${pr.prid}-${revision}`
      : undefined;
    const cached = cacheKey && cache?.get(cacheKey, '.json');
    if (Array.isArray(cached)) {
      return cached;
    }

    const files = [];
    for await (const file of request.getPullRequestFiles(pr)) {
      files.push({
        filename: file.filename,
        previous_filename: file.previous_filename
      });
    }
    if (cacheKey) {
      cache?.write(cacheKey, '.json', files);
    }
    return files;
  }

  async filterPRModifiedTests(request, cache) {
    const prs = new Map();
    const jsFailures = this.failures.filter((failure) =>
      failure.type === JS_TEST_FAILURE && failure.file);
    const groupedByReason = Object.groupBy(jsFailures, getHighlight);
    for (const failures of Object.values(groupedByReason)) {
      const groupPRs = new Map();
      for (const failure of failures) {
        const pr = parsePRFromURL(failure.source);
        if (pr) {
          groupPRs.set(failure.source, {
            pr,
            revision: failure.revision
          });
        }
      }
      if (groupPRs.size >= 2) {
        for (const [source, data] of groupPRs) {
          prs.set(source, data);
        }
      }
    }

    const modifiedTests = new Map();
    await Promise.all(Array.from(prs, async([source, data]) => {
      const files = new Set();
      try {
        const changedFiles = await this.getPullRequestFiles(
          request, data.pr, data.revision, cache);
        for (const file of changedFiles) {
          for (const filename of [file.filename, file.previous_filename]) {
            if (filename?.startsWith('test/')) {
              files.add(normalizeTestPath(filename));
            }
          }
        }
        modifiedTests.set(source, files);
      } catch {
        this.cli.warn(`Could not fetch modified test files for ${source}`);
      }
    }));

    this.failures = this.failures.filter((failure) => {
      if (failure.type !== JS_TEST_FAILURE || !failure.file) {
        return true;
      }
      return !modifiedTests.get(failure.source)?.has(
        normalizeTestPath(failure.file));
    });
    this.aggregates = null;
    return this.failures;
  }

  aggregate() {
    const groupedByReason = Object.groupBy(this.failures, getHighlight);
    const data = [];
    for (const reason of Object.keys(groupedByReason).sort()) {
      const failures = groupedByReason[reason];
      // Uncomment this and redirect stderr away to see matched highlights
      // console.log('HIGHLIGHT', reason);

      // If multiple sub builds of one PR are failed by the same reason,
      // we'll only take one of those builds, as that might be a genuine failure
      const prs = uniqBy(failures, 'source')
        .map(({ source, upstream }) => ({ source, upstream, _id: parseJobFromURL(upstream).jobid }))
        .sort((a, b) => a._id - b._id);
      const machines = uniqBy(
        failures.map(f => ({ hostname: f.builtOn, url: f.url })),
        'hostname');
      data.push({
        reason, type: failures[0].type, failures, prs, machines
      });
    }

    const groupedByType = Object.groupBy(data, ({ type }) => type);
    for (const group of Object.values(groupedByType)) {
      group.sort((a, b) => b.prs.length - a.prs.length);
    }
    this.aggregates = groupedByType;
    return groupedByType;
  }

  formatAsMarkdown() {
    let { aggregates } = this;
    if (!aggregates) {
      aggregates = this.aggregates = this.aggregate();
    }

    const last = parseJobFromURL(this.unfilteredFailures[0].upstream);
    const first = parseJobFromURL(
      this.unfilteredFailures[this.unfilteredFailures.length - 1].upstream
    );
    const jobName = CI_TYPES.get(first.type).jobName;
    let output = 'Failures in ';
    output += `[${jobName}/${first.jobid}](${first.link}) to `;
    output += `[${jobName}/${last.jobid}](${last.link}) `;
    output += 'that failed 2 or more PRs\n';
    output += '(Generated with `ncu-ci ';
    output += `${process.argv.slice(2).join(' ')}\`)\n\n`;

    output += this.health.formatAsMarkdown() + '\n';

    const todo = [];
    for (const type of Object.keys(aggregates)) {
      if (aggregates[type].length === 0) {
        continue;
      }
      output += `\n### ${FAILURE_TYPES_NAME[type]}\n\n`;
      for (const item of aggregates[type]) {
        const { reason, type, prs, failures, machines } = item;
        if (prs.length < 2) { continue; }
        todo.push({ count: prs.length, reason });
        output += markdownRow('Reason', `<code>${reason}</code>`);
        output += markdownRow('-', ':-');
        output += markdownRow('Type', type);
        const source = prs.map(f => `[${f.source}](${f.upstream})`);
        output += markdownRow(
          'Failed PR', `${source.length} (${source.join(', ')})`
        );
        output += markdownRow(
          'Appeared', machines.map(getMachineUrl).join(', ')
        );
        if (prs.length > 1) {
          output += markdownRow('First CI', `${prs[0].upstream}`);
        }
        output += markdownRow('Last CI', `${prs[prs.length - 1].upstream}`);
        output += '\n';
        const example = failures[0].reason;
        output += fold(
          `<a href="${failures[0].url}">Example</a>`,
          (example.length > 1024 ? example.slice(0, 1024) + '...' : example)
        );
        output += '\n\n-------\n\n';
      }
    }

    output += '### Progress\n\n';
    output += todo.map(
      ({ count, reason }) => `- [ ] \`${reason}\` (${count})`).join('\n'
    );
    return output + '\n';
  }

  display() {
    let { cli, aggregates } = this;
    if (!aggregates) {
      aggregates = this.aggregates = this.aggregate();
    }

    for (const type of Object.keys(aggregates)) {
      cli.separator(type);
      for (const item of aggregates[type]) {
        const { reason, type, prs, failures, machines } = item;
        cli.table('Reason', reason);
        cli.table('Type', type);
        const source = prs
          .map(f => {
            const parsed = parsePRFromURL(f.source);
            return parsed ? `#${parsed.prid}` : f.source;
          });
        cli.table('Failed PR', `${source.length} (${source.join(', ')})`);
        cli.table('Appeared', machines.map(m => m.hostname).join(', '));
        if (prs.length > 1) {
          cli.table('First CI', `${prs[0].upstream}`);
        }
        cli.table('Last CI', `${prs[prs.length - 1].upstream}`);
        cli.log('\n' + chalk.bold('Example: ') + `${failures[0].url}\n`);
        const example = failures[0].reason;
        cli.log(example.length > 512 ? example.slice(0, 512) + '...' : example);
        cli.separator();
      }
    }
  }
}
