/**
 * The dev-server tenant proxy: allowlist enforcement, and — the one that matters — proof that no
 * secret ever reaches a log line. Driven as a plain function with an injected fetch and logger,
 * so there is no server and no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forward } from '../scripts/vite-plugin-tenant-proxy.js';

/** Minimal ServerResponse stand-in. */
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    payload: null,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(text) {
      this.payload = JSON.parse(text);
    },
  };
}

const okFetch = (body = { error: 'insufficient_authorization', auth_session: 'x', next: [] }, status = 403) =>
  async () => ({
    status,
    async text() {
      return JSON.stringify(body);
    },
    headers: { get: (h) => (h === 'content-type' ? 'application/json' : null) },
  });

test('forwards to an allowlisted host and returns the upstream envelope', async () => {
  const res = fakeRes();
  let calledUrl = null;
  await forward(
    { domain: 'nelson.jp.auth0.com', path: '/e/authorize', method: 'POST', body: { client_id: 'abc' } },
    res,
    {
      doFetch: async (url, init) => {
        calledUrl = url;
        assert.equal(init.headers['content-type'], 'application/json');
        return (await okFetch()())();
      },
    }
  ).catch(() => {});

  // Re-run cleanly with a well-formed fake.
  const res2 = fakeRes();
  await forward(
    { domain: 'nelson.jp.auth0.com', path: '/e/authorize', method: 'POST', body: { client_id: 'abc' } },
    res2,
    { doFetch: async (url) => { calledUrl = url; return okFetch()(); } }
  );
  assert.equal(calledUrl, 'https://nelson.jp.auth0.com/e/authorize');
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.payload.ok, true);
  assert.equal(res2.payload.status, 403);
});

test('rejects a host outside the allowlist', async () => {
  const res = fakeRes();
  let fetched = false;
  await forward(
    { domain: 'evil.example.com', path: '/e/authorize', body: {} },
    res,
    { doFetch: async () => { fetched = true; return okFetch()(); } }
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'host_not_allowed');
  assert.equal(fetched, false, 'must not have made the request at all');
});

test('rejects a path outside the allowlist', async () => {
  const res = fakeRes();
  await forward({ domain: 'x.auth0.com', path: '/api/v2/users', body: {} }, res, {
    doFetch: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'path_not_allowed');
});

test('a URL smuggled through the domain field cannot redirect the request', async () => {
  const res = fakeRes();
  let calledUrl = null;
  await forward(
    { domain: 'https://nelson.jp.auth0.com/evil?x=1', path: '/e/authorize', body: {} },
    res,
    { doFetch: async (url) => { calledUrl = url; return okFetch()(); } }
  );
  // Host is extracted and the URL rebuilt from validated parts; the smuggled path is discarded.
  assert.equal(calledUrl, 'https://nelson.jp.auth0.com/e/authorize');
});

test('refuses a payload carrying a client_secret', async () => {
  const res = fakeRes();
  let fetched = false;
  await forward(
    { domain: 'x.auth0.com', path: '/oauth/token', body: { client_id: 'a', client_secret: 'shhh' } },
    res,
    { doFetch: async () => { fetched = true; return okFetch()(); } }
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error, 'client_secret_rejected');
  assert.equal(fetched, false);
  assert.ok(!JSON.stringify(res.payload).includes('shhh'), 'must not echo the secret back');
});

test('no secret from a request or response body ever reaches a log line', async () => {
  const lines = [];
  const res = fakeRes();

  const PASSWORD = 'correct horse battery staple';
  const OTP = '123456';
  const CODE = 'auth_code_super_secret';

  await forward(
    {
      domain: 'nelson.jp.auth0.com',
      path: '/e/authorize',
      method: 'POST',
      body: { auth_session: 's', action: 'action:enroll:password:v1', password: PASSWORD, otp: OTP },
    },
    res,
    {
      log: (m) => lines.push(String(m)),
      warn: (m) => lines.push(String(m)),
      doFetch: async () => ({
        status: 200,
        async text() {
          return JSON.stringify({ authorization_code: CODE, id_token: 'ey.secret.jwt' });
        },
        headers: { get: () => 'application/json' },
      }),
    }
  );

  assert.ok(lines.length > 0, 'the call should have been logged at all');
  const all = lines.join('\n');
  for (const secret of [PASSWORD, OTP, CODE, 'ey.secret.jwt', 'action:enroll:password:v1']) {
    assert.ok(!all.includes(secret), `log leaked "${secret}": ${all}`);
  }
  // What it *should* contain: enough to debug.
  assert.match(all, /POST \/e\/authorize/);
  assert.match(all, /200/);
  assert.match(all, /nelson\.jp\.auth0\.com/);

  // The authorization code must still reach the caller — redaction is a log concern only.
  assert.equal(res.payload.body.authorization_code, CODE);
});

test('an unreachable upstream reports failure without leaking the body', async () => {
  const lines = [];
  const res = fakeRes();
  await forward(
    { domain: 'x.auth0.com', path: '/e/authorize', body: { password: 'hunter2' } },
    res,
    {
      log: (m) => lines.push(String(m)),
      warn: (m) => lines.push(String(m)),
      doFetch: async () => { throw new Error('ECONNREFUSED'); },
    }
  );
  assert.equal(res.payload.ok, false);
  assert.equal(res.payload.error, 'upstream_unreachable');
  assert.ok(!lines.join('\n').includes('hunter2'));
  assert.ok(!JSON.stringify(res.payload).includes('hunter2'));
});

test('form encoding is used only when asked for', async () => {
  let init = null;
  const res = fakeRes();
  await forward(
    {
      domain: 'x.auth0.com',
      path: '/oauth/token',
      body: { grant_type: 'authorization_code', code: 'c' },
      contentType: 'application/x-www-form-urlencoded',
    },
    res,
    { doFetch: async (_u, i) => { init = i; return okFetch({}, 200)(); } }
  );
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(init.body, 'grant_type=authorization_code&code=c');
});

test('only GET and POST are forwarded', async () => {
  const res = fakeRes();
  await forward({ domain: 'x.auth0.com', path: '/e/authorize', method: 'DELETE' }, res, {
    doFetch: async () => { throw new Error('should not be called'); },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error, 'method_not_allowed');
});
