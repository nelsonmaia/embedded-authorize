/**
 * The deployed server.
 *
 * Two things are being proven here. The first is the bug that prompted it: a built app POSTing to
 * /__tenant used to reach a static file host, which answers anything that is not a GET with 405 —
 * an error about HTTP methods for what is actually a missing backend.
 *
 * The second matters more. The dev proxy is safe because it is bound to localhost and there is one
 * of you. The same code reachable by anyone becomes a relay they can point at any Auth0 tenant,
 * from your server's address. Strict mode is what stops that, so it is tested from both sides:
 * that a named tenant still works, and that an unnamed one is refused even though its host matches
 * the suffix the dev server would have accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { forward } from '../scripts/tenant-proxy/forward.js';
import { createConsoleServer } from '../server.js';

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(text) { this.payload = JSON.parse(text); },
  };
}

const reached = [];
const spyFetch = async (url) => {
  reached.push(url);
  return {
    status: 403,
    async text() { return '{"error":"insufficient_authorization"}'; },
    headers: { get: () => 'application/json' },
  };
};

const envelope = (domain) => ({ domain, path: '/e/authorize', method: 'POST', body: {} });

/* ── strict mode ────────────────────────────────────────────────────────── */

test('a deployment with no allowlist forwards nothing, and says what to set', async () => {
  const res = fakeRes();
  await forward(envelope('nelson.jp.auth0.com'), res, { strict: true, allowedHosts: [], doFetch: spyFetch });

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, 'no_allowlist');
  assert.match(res.payload.detail, /PLAYGROUND_ALLOWED_HOSTS/, 'an operator must learn the fix from the error');
});

test('a named tenant is forwarded', async () => {
  reached.length = 0;
  const res = fakeRes();
  await forward(envelope('nelson.jp.auth0.com'), res, {
    strict: true,
    allowedHosts: ['nelson.jp.auth0.com'],
    doFetch: spyFetch,
  });

  assert.equal(res.payload.ok, true);
  assert.deepEqual(reached, ['https://nelson.jp.auth0.com/e/authorize']);
});

test('an unnamed tenant is refused even though the suffix would pass in dev', async () => {
  // The whole point of strict mode. In dev this exact call succeeds; deployed it must not, or the
  // console is a credential-stuffing relay with a friendly UI.
  reached.length = 0;
  const strict = fakeRes();
  await forward(envelope('someone-else.auth0.com'), strict, {
    strict: true,
    allowedHosts: ['nelson.jp.auth0.com'],
    doFetch: spyFetch,
  });

  assert.equal(strict.statusCode, 403);
  assert.equal(strict.payload.error, 'host_not_allowed');
  assert.equal(reached.length, 0, 'nothing may leave the server');

  const dev = fakeRes();
  await forward(envelope('someone-else.auth0.com'), dev, { allowedHosts: [], doFetch: spyFetch });
  assert.equal(dev.payload.ok, true, 'the dev server still accepts any tenant, which is the difference');
});

test('strict mode does not widen what a path or method may be', async () => {
  const allowedHosts = ['nelson.jp.auth0.com'];
  for (const [patch, error] of [
    [{ path: '/api/v2/users' }, 'path_not_allowed'],
    [{ method: 'DELETE' }, 'method_not_allowed'],
    [{ body: { client_secret: 'shh' } }, 'client_secret_rejected'],
  ]) {
    const res = fakeRes();
    await forward({ ...envelope('nelson.jp.auth0.com'), ...patch }, res, { strict: true, allowedHosts, doFetch: spyFetch });
    assert.equal(res.payload.error, error);
  }
});

/* ── the server ─────────────────────────────────────────────────────────── */

async function withServer(run) {
  const server = createConsoleServer();
  server.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('GET /__tenant answers as itself, not as a static file host', async () => {
  // The reported bug: a 405 from a static host reads as "wrong HTTP method" when the real problem
  // was that no backend existed. Here a 405 means what it says, and arrives as JSON the console
  // can render rather than an HTML error page it would fail to parse.
  await withServer(async (base) => {
    const res = await fetch(`${base}/__tenant`);
    assert.equal(res.status, 405);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal((await res.json()).error, 'method_not_allowed');
  });
});

test('the Jira endpoint is served, and issues this browser its own session', async () => {
  // It is mounted in a deployment only because tokens are per browser session. If that ever
  // regresses to module state, the second visitor inherits the first visitor's Jira account.
  await withServer(async (base) => {
    const res = await fetch(`${base}/__jira`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.connected, false);
    assert.equal(body.transport, 'mcp');

    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /ea_jira=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    // Two fetches with no cookie are two different browsers, and get two different sessions.
    const other = await fetch(`${base}/__jira`);
    assert.notEqual(other.headers.get('set-cookie'), cookie);
  });
});

test('an unknown Jira route 404s as JSON rather than falling through to the app', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/__jira/nope`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type'), /application\/json/);
  });
});

test('a traversal cannot escape the build directory', async () => {
  await withServer(async (base) => {
    for (const attack of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/server.js']) {
      const res = await fetch(`${base}${attack}`);
      const text = await res.text();
      assert.ok(!/"dependencies"|createConsoleServer/.test(text), `${attack} escaped the tree`);
    }
  });
});

test('an unknown path falls back to the app, so a deep link survives a reload', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/some/deep/link`);
    const text = await res.text();
    // Without a build there is nothing to fall back to, and saying so beats a confusing 404.
    if (res.status === 500) return assert.equal(JSON.parse(text).error, 'not_built');

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-cache', 'the entry point must never be cached hard');
    assert.match(text, /<div id="root">|<script/);
  });
});

test('a write to anything but the proxy is refused', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/index.html`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});
