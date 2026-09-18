/**
 * The deployed server.
 *
 * Two things are being proven here. The first is the bug that prompted it: a built app POSTing to
 * /__tenant used to reach a static file host, which answers anything that is not a GET with 405 —
 * an error about HTTP methods for what is actually a missing backend.
 *
 * The second is what now bounds the proxy. There is no tenant allowlist: any Auth0 tenant, on any
 * domain, is reachable without configuration, because a console you have to edit an env var to
 * point at your own tenant is not a console anyone else can use. What is left holding the line is
 * tested here from both sides — the three paths, GET/POST only, no client_secret, and a `domain`
 * that must be a routable public hostname rather than a URL or an address inside the network the
 * server happens to sit in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { forward, hostOf } from '../scripts/tenant-proxy/forward.js';
import { createConsoleServer } from '../server.js';
import { explainMissingProxy } from '../src/data/serverProbe.js';

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

/* ── any tenant, no configuration ───────────────────────────────────────── */

test('any tenant is forwarded, with nothing configured', async () => {
  // The point of the change. None of these share a suffix, and no allowlist is passed: a stranger
  // opening the deployed console types their own tenant and it works.
  for (const domain of [
    'nelson.jp.auth0.com',
    'someone-else.auth0.com',
    'login.acme.example',
    'tenant.au.auth0lab.com',
  ]) {
    reached.length = 0;
    const res = fakeRes();
    await forward(envelope(domain), res, { doFetch: spyFetch });

    assert.equal(res.payload.ok, true, domain);
    assert.deepEqual(reached, [`https://${domain}/e/authorize`]);
  }
});

test('a domain must be a hostname, not a URL or a fragment of one', async () => {
  // hostOf strips a scheme, a path and a port, so the request cannot be redirected by what is
  // typed. Whatever survives that has to still look like a public hostname, or nothing is sent.
  for (const domain of ['', '   ', 'https://', 'not a host', 'tenant', 'under_score.example.com']) {
    reached.length = 0;
    const res = fakeRes();
    await forward(envelope(domain), res, { doFetch: spyFetch });

    assert.equal(res.statusCode, 400, JSON.stringify(domain));
    assert.match(res.payload.error, /^(missing_domain|invalid_domain)$/, JSON.stringify(domain));
    assert.equal(reached.length, 0, 'nothing may leave the server');
  }
});

test('a URL in the domain field is reduced to its host, not followed', async () => {
  for (const written of [
    'https://nelson.jp.auth0.com/oauth/token?x=1',
    'HTTPS://Nelson.JP.Auth0.com/',
    'nelson.jp.auth0.com:8443',
  ]) {
    reached.length = 0;
    const res = fakeRes();
    await forward(envelope(written), res, { doFetch: spyFetch });

    assert.equal(res.payload.ok, true, written);
    assert.deepEqual(reached, ['https://nelson.jp.auth0.com/e/authorize'], written);
  }
  assert.equal(hostOf(''), '');
  assert.equal(hostOf(undefined), '');
});

test('the server will not be used to reach the network it sits in', async () => {
  // No tenant lives at a loopback, private or link-local address, so refusing them costs nothing
  // and keeps an open proxy from becoming a probe for the metadata service next door.
  for (const domain of [
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.9.9',
    '169.254.169.254',
    'localhost.localdomain',
    'metadata.internal',
    'printer.local',
    '[::1]',
  ]) {
    reached.length = 0;
    const res = fakeRes();
    await forward(envelope(domain), res, { doFetch: spyFetch });

    assert.equal(res.payload.error, 'invalid_domain', domain);
    assert.equal(reached.length, 0, `nothing may leave the server for ${domain}`);
  }
});

test('dropping the allowlist did not widen what a path or method may be', async () => {
  for (const [patch, error] of [
    [{ path: '/api/v2/users' }, 'path_not_allowed'],
    [{ method: 'DELETE' }, 'method_not_allowed'],
    [{ body: { client_secret: 'shh' } }, 'client_secret_rejected'],
  ]) {
    reached.length = 0;
    const res = fakeRes();
    await forward({ ...envelope('nelson.jp.auth0.com'), ...patch }, res, { doFetch: spyFetch });
    assert.equal(res.payload.error, error);
    assert.equal(reached.length, 0);
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

/* ── telling one failure from the other ─────────────────────────────────── */

test('/__health identifies this server, and nothing static can fake it', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/__health`);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    // The name is the check. A static host answers /__health with index.html and a 200, so a
    // status code alone proves nothing.
    assert.equal(body.server, 'embedded-authorize');
    assert.ok(body.routes.includes('/__tenant'));
    assert.equal(res.headers.get('cache-control'), 'no-store', 'a cached health check answers for the past');
  });
});

test('the two ways live mode can fail get different advice', () => {
  // Both surface as "POST /__tenant returned 405", and they need opposite fixes: one is a missing
  // process, the other a misrouted path in front of a running one. Conflating them sent a real
  // deployment to its CORS settings, which were never involved.
  const noServer = explainMissingProxy({ running: false, servedBy: 'static', status: 200 }, 405);
  assert.match(noServer, /served as static files/);
  assert.match(noServer, /node server\.js/, 'it must say what to run');
  assert.ok(!/HTTP 200/.test(noServer), 'reporting the 200 from index.html reads as success');
  assert.match(noServer, /HTML instead of JSON/, 'name the evidence, not the status code');

  const misrouted = explainMissingProxy({ running: true, server: 'embedded-authorize' }, 405);
  assert.match(misrouted, /server is running/);
  assert.match(misrouted, /nginx|ingress/, 'it must point at what sits in front');
  assert.ok(!/npm run dev/.test(misrouted), 'starting a server is not the fix when one is running');
});

/* ── mounted under a path, not at a domain root ─────────────────────────── */

const MOUNT = '/a0-b2c-core/apps/v1/embedded-authorize';

test('the API routes answer whether or not they arrive wearing a mount prefix', async () => {
  // A platform may serve the console under a path and proxy through with the prefix intact. An
  // unmatched /__tenant does not 404 — it falls through to the SPA and returns index.html, which
  // the console then reports as "no server" while looking straight at one.
  await withServer(async (base) => {
    for (const prefix of ['', MOUNT, '/some/other/mount']) {
      const health = await fetch(`${base}${prefix}/__health`);
      assert.equal(health.status, 200, `${prefix || '(root)'} /__health`);
      assert.equal((await health.json()).server, 'embedded-authorize');

      const tenant = await fetch(`${base}${prefix}/__tenant`);
      assert.equal(tenant.status, 405, `${prefix || '(root)'} /__tenant should be the proxy, not the SPA`);
      assert.match(tenant.headers.get('content-type'), /application\/json/);

      const jira = await fetch(`${base}${prefix}/__jira`);
      assert.equal((await jira.json()).transport, 'mcp', `${prefix || '(root)'} /__jira`);
    }
  });
});

test('a path that merely starts like a route is not one', async () => {
  await withServer(async (base) => {
    // /__tenantfoo shares a prefix with /__tenant and is not it; it must reach the SPA instead.
    const res = await fetch(`${base}/__tenantfoo`);
    const type = res.headers.get('content-type') ?? '';
    assert.ok(!type.includes('application/json') || res.status !== 405, '/__tenantfoo was treated as the proxy');
  });
});

test('assets resolve under a mount prefix', async () => {
  await withServer(async (base) => {
    const index = await fetch(`${base}/`);
    if (index.status !== 200) return; // no build present; the SPA test already covers that
    const html = await index.text();

    const asset = (html.match(/(?:\.\/|\/)?assets\/[A-Za-z0-9._-]+\.js/) ?? [])[0];
    if (!asset) return;
    const clean = asset.replace(/^\.?\//, '');

    const res = await fetch(`${base}${MOUNT}/${clean}`);
    assert.equal(res.status, 200, `${MOUNT}/${clean}`);
    assert.match(res.headers.get('content-type'), /javascript/, 'a prefixed asset must not fall back to index.html');
  });
});
