import { randomBytes } from 'node:crypto';
import {
  request as requestHttp,
  STATUS_CODES
} from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 20;

function hasHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some(header => header.toLowerCase() === lowerName);
}

function deleteHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === lowerName) delete headers[header];
  }
}

function isSameOrigin(first, second) {
  return first.protocol === second.protocol && first.host === second.host;
}

function consume(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

class Response {
  #message;

  constructor(message, url, redirected) {
    this.#message = message;
    this.body = message;
    this.headers = message.headers;
    this.ok = message.statusCode >= 200 && message.statusCode < 300;
    this.redirected = redirected;
    this.status = message.statusCode;
    this.statusText = message.statusMessage || STATUS_CODES[message.statusCode] || '';
    this.url = url.href;
  }

  async arrayBuffer() {
    const buffer = await consume(this.#message);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
  }

  async text() {
    return Buffer.from(await this.arrayBuffer()).toString();
  }

  async json() {
    return JSON.parse(await this.text());
  }
}

export class MultipartBody {
  #boundary = `----node-core-utils-${randomBytes(12).toString('hex')}`;
  #fields = [];

  append(name, value) {
    if (/\r|\n/.test(name)) {
      throw new TypeError('Multipart field names cannot contain newlines');
    }
    this.#fields.push([name.replaceAll('"', '%22'), String(value)]);
  }

  get contentType() {
    return `multipart/form-data; boundary=${this.#boundary}`;
  }

  toBuffer() {
    const parts = this.#fields.map(([name, value]) =>
      `--${this.#boundary}\r\n` +
      `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
      `${value}\r\n`
    );
    parts.push(`--${this.#boundary}--\r\n`);
    return Buffer.from(parts.join(''));
  }
}

function normalizeBody(body, headers) {
  if (body == null) return body;

  if (body instanceof MultipartBody) {
    if (!hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = body.contentType;
    }
    return body.toBuffer();
  }

  if (typeof body === 'string') {
    if (!hasHeader(headers, 'content-type')) {
      headers['Content-Type'] = 'text/plain;charset=UTF-8';
    }
    return Buffer.from(body);
  }

  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Readable) return body;

  throw new TypeError(`Unsupported request body: ${body.constructor?.name || typeof body}`);
}

function redirectOptions(url, nextUrl, status, options) {
  const next = {
    ...options,
    headers: { ...options.headers }
  };

  if (!isSameOrigin(url, nextUrl)) {
    deleteHeader(next.headers, 'authorization');
    deleteHeader(next.headers, 'cookie');
    deleteHeader(next.headers, 'proxy-authorization');
  }

  if (status === 303 || ((status === 301 || status === 302) && options.method === 'POST')) {
    next.method = 'GET';
    next.body = undefined;
    deleteHeader(next.headers, 'content-length');
    deleteHeader(next.headers, 'content-type');
    deleteHeader(next.headers, 'transfer-encoding');
  }

  return next;
}

export function sendRequest(input, options = {}) {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  return send(input, options, maxRedirects, false);
}

function send(input, options, redirectsRemaining, redirected) {
  const url = input instanceof URL ? input : new URL(input);
  const request = url.protocol === 'http:'
    ? requestHttp
    : url.protocol === 'https:'
      ? requestHttps
      : null;
  if (request == null) {
    return Promise.reject(new TypeError(`Unsupported protocol: ${url.protocol}`));
  }

  const headers = { ...options.headers };
  let body;
  try {
    body = normalizeBody(options.body, headers);
  } catch (error) {
    return Promise.reject(error);
  }
  if (body != null && !(body instanceof Readable) &&
      !hasHeader(headers, 'content-length') &&
      !hasHeader(headers, 'transfer-encoding')) {
    headers['Content-Length'] = body.byteLength;
  }

  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: options.agent,
      headers,
      method: options.method || 'GET',
      signal: options.signal
    }, message => {
      const status = message.statusCode;
      const location = message.headers.location;
      if (location != null && REDIRECT_STATUSES.has(status)) {
        if (redirectsRemaining === 0) {
          message.resume();
          reject(new TypeError('Maximum redirect count exceeded'));
          return;
        }

        const nextUrl = new URL(location, url);
        const nextOptions = redirectOptions(url, nextUrl, status, {
          ...options,
          headers,
          method: options.method || 'GET'
        });
        message.resume();
        resolve(send(nextUrl, nextOptions, redirectsRemaining - 1, true));
        return;
      }

      resolve(new Response(message, url, redirected));
    });

    req.on('error', reject);
    if (body instanceof Readable) {
      body.on('error', error => req.destroy(error));
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}
