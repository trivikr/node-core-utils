import { once } from 'node:events';
import { Agent, createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';

import { MultipartBody, sendRequest } from '../../lib/http.js';

describe('native HTTP requests', () => {
  let origin;
  let proxyOrigin;
  let proxyServer;
  let server;

  before(async() => {
    server = createServer(async(req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();

      switch (req.url) {
        case '/json':
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          break;
        case '/post':
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ body, headers: req.headers }));
          break;
        case '/redirect':
          res.writeHead(302, { Location: '/json' });
          res.end();
          break;
        case '/redirect-loop':
          res.writeHead(302, { Location: '/redirect-loop' });
          res.end();
          break;
        default:
          res.writeHead(404);
          res.end();
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;

    proxyServer = createServer((req, res) => {
      res.end(req.url);
    });
    proxyServer.listen(0, '127.0.0.1');
    await once(proxyServer, 'listening');
    proxyOrigin = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  after(async() => {
    server.close();
    proxyServer.close();
    await Promise.all([once(server, 'close'), once(proxyServer, 'close')]);
  });

  it('provides the response helpers used by callers', async() => {
    const response = await sendRequest(`${origin}/json`);

    assert.strictEqual(response.ok, true);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.statusText, 'OK');
    assert.deepStrictEqual(await response.json(), { ok: true });
  });

  it('sends string request bodies with fetch-compatible headers', async() => {
    const response = await sendRequest(`${origin}/post`, {
      method: 'POST',
      body: 'hello'
    });
    const result = await response.json();

    assert.strictEqual(response.status, 201);
    assert.strictEqual(result.body, 'hello');
    assert.strictEqual(result.headers['content-length'], '5');
    assert.strictEqual(result.headers['content-type'], 'text/plain;charset=UTF-8');
  });

  it('encodes multipart form data', async() => {
    const form = new MultipartBody();
    form.append('json', '{"hello":"world"}');
    const response = await sendRequest(`${origin}/post`, {
      method: 'POST',
      body: form
    });
    const result = await response.json();
    const boundary = result.headers['content-type'].split('boundary=')[1];

    assert.match(result.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.strictEqual(
      result.body,
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="json"\r\n\r\n' +
      '{"hello":"world"}\r\n' +
      `--${boundary}--\r\n`
    );
  });

  it('follows redirects', async() => {
    const response = await sendRequest(`${origin}/redirect`);

    assert.strictEqual(response.redirected, true);
    assert.strictEqual(response.url, `${origin}/json`);
    assert.deepStrictEqual(await response.json(), { ok: true });
  });

  it('limits redirects', async() => {
    await assert.rejects(
      sendRequest(`${origin}/redirect-loop`, { maxRedirects: 1 }),
      /Maximum redirect count exceeded/
    );
  });

  it('supports dynamically configured native proxy agents', async() => {
    const agent = new Agent({ proxyEnv: { HTTP_PROXY: proxyOrigin } });
    const response = await sendRequest(`${origin}/json`, { agent });

    assert.strictEqual(await response.text(), `${origin}/json`);
  });
});
