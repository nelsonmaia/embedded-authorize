/**
 * Per-browser Jira sessions.
 *
 * The bug being prevented: the first version held one access token in module state, so the second
 * person to open a deployed console would inherit the first person's Jira account and file tickets
 * as them. These assert the isolation directly rather than trusting the shape of the code.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { COOKIE, isSecure, parseCookies, reset, sessionFor, signOut } from '../scripts/jira-mcp/sessions.js';

beforeEach(reset);

const req = (cookie, headers = {}) => ({ headers: { ...(cookie ? { cookie } : {}), ...headers }, socket: {} });
const res = () => {
  const headers = {};
  return { headers, setHeader: (k, v) => { headers[k.toLowerCase()] = v; }, cookie: () => headers['set-cookie'] };
};

const cookieFor = (r) => `${COOKIE}=${String(r.cookie()).match(/ea_jira=([^;]+)/)[1]}`;

test('two browsers get two sessions, and neither can see the other', () => {
  const a = res();
  const first = sessionFor(req(null), a);
  first.session.tokens = { accessToken: 'alice-token' };

  const second = sessionFor(req(null), res());
  assert.notEqual(second.id, first.id);
  assert.equal(second.session.tokens, null, "the second browser must not inherit the first's token");

  // And the first browser still has its own on the next request.
  const again = sessionFor(req(cookieFor(a)), res());
  assert.equal(again.session.tokens.accessToken, 'alice-token');
  assert.equal(again.created, false, 'a returning browser is not issued a new session');
});

test('signing one browser out leaves the other connected', () => {
  const a = res();
  sessionFor(req(null), a).session.tokens = { accessToken: 'alice' };
  const b = res();
  sessionFor(req(null), b).session.tokens = { accessToken: 'bob' };

  signOut(sessionFor(req(cookieFor(a)), res()).session);

  assert.equal(sessionFor(req(cookieFor(a)), res()).session.tokens, null);
  assert.equal(sessionFor(req(cookieFor(b)), res()).session.tokens.accessToken, 'bob');
});

test('a PKCE verifier belongs to the browser that started the flow', () => {
  // Why it matters: the callback carries `state` in a URL, which is observable. Holding the
  // verifier per session means seeing a state value is not enough to complete someone's sign-in.
  const a = res();
  sessionFor(req(null), a).session.pending.set('shared-state', { verifier: 'v', at: Date.now() });

  const other = sessionFor(req(null), res()).session;
  assert.equal(other.pending.get('shared-state'), undefined);
});

test('an unknown or forged cookie starts a fresh session rather than resuming one', () => {
  const made = sessionFor(req(null), res());
  made.session.tokens = { accessToken: 'real' };

  for (const forged of [`${COOKIE}=not-a-real-id`, `${COOKIE}=`, 'unrelated=1']) {
    const got = sessionFor(req(forged), res());
    assert.equal(got.session.tokens, null);
    assert.equal(got.created, true);
  }
});

test('the cookie is not reachable by page scripts, and survives the OAuth return', () => {
  const r = res();
  sessionFor(req(null), r);
  const cookie = r.cookie();

  assert.match(cookie, /HttpOnly/, 'an XSS must not be able to read it');
  // Lax is required, not merely chosen: the callback is a top-level cross-site navigation back
  // from auth.atlassian.com, and Strict would withhold the cookie exactly there.
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);
});

test('Secure is set over HTTPS and omitted on plain localhost', () => {
  const overTls = res();
  sessionFor(req(null, { 'x-forwarded-proto': 'https' }), overTls);
  assert.match(overTls.cookie(), /Secure/, 'a deployment must not send it in the clear');

  const local = res();
  sessionFor(req(null), local);
  assert.ok(!/Secure/.test(local.cookie()), 'localhost has no HTTPS, and the flag would break it');

  assert.equal(isSecure({ headers: { 'x-forwarded-proto': 'https,http' }, socket: {} }), true);
  assert.equal(isSecure({ headers: {}, socket: { encrypted: true } }), true);
  assert.equal(isSecure({ headers: {}, socket: {} }), false);
});

test('a session id is not guessable', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const r = res();
    sessionFor(req(null), r);
    ids.add(String(r.cookie()).match(/ea_jira=([^;]+)/)[1]);
  }
  assert.equal(ids.size, 200);
  // 32 random bytes, base64url — 43 characters, no padding.
  assert.ok([...ids].every((id) => id.length >= 43 && /^[A-Za-z0-9_-]+$/.test(id)));
});

test('cookie parsing does not confuse one name for another', () => {
  const parsed = parseCookies('other=1; ea_jira=abc; ea_jira_extra=nope');
  assert.equal(parsed.ea_jira, 'abc');
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('malformed'), {});
});

test('the handler keeps no per-user state outside the session', () => {
  // The regression this guards: module-level `state.tokens`, which is how the first version leaked
  // one person's account to everyone. Only public things may be shared.
  const src = readFileSync(new URL('../scripts/jira-mcp/handler.js', import.meta.url), 'utf8');
  const shared = src.slice(src.indexOf('const shared = {'), src.indexOf('};', src.indexOf('const shared = {')));

  assert.match(shared, /discovery/);
  assert.match(shared, /client/);
  for (const forbidden of ['tokens', 'user', 'mcp', 'pending']) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(shared), `"${forbidden}" must be per session`);
  }
});
