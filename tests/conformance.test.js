/**
 * The live-mode conformance checker.
 *
 * Two things are at stake. It must catch a real deviation — otherwise live mode is two JSON blobs
 * and a reader's patience — and it must not cry wolf on a correct response, because a checker that
 * flags healthy traffic gets ignored within a day.
 *
 * The second half of this file is the check that caught four registry errors when it was first
 * run: what the registry says an action emits, against what the modelled calls actually carry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkResponse, summarise, wasAccepted } from '../src/data/conformance.js';
import { byId, ERRORS } from '../src/data/spec.js';
import { ACTION_CATALOG } from '../src/data/signupPrd.js';

const check = (status, body, sent = {}) =>
  checkResponse({ request: { body: sent }, status, body });

const titles = (findings) => findings.map((f) => f.title);
const has = (findings, fragment) => findings.some((f) => f.title.includes(fragment));

/* ── it stays quiet when the tenant is right ────────────────────────────── */

test('a conformant continuation produces no findings', () => {
  const findings = check(
    403,
    {
      error: 'insufficient_authorization',
      auth_session: 'fresh',
      next: [{ action: 'action:verify:otp:v1', channel: 'email', identifier: 'ha***@ok***' }],
    },
    { auth_session: 'previous', action: 'action:challenge:email:v1' }
  );
  assert.deepEqual(findings, [], JSON.stringify(titles(findings)));
});

test('a conformant final response produces no findings', () => {
  assert.deepEqual(check(200, { authorization_code: 'AUTH_CODE_x' }), []);
});

test('a challenge descriptor with index is not flagged', () => {
  // It was, until the registry was corrected: it declared `channel`, which belongs to verify:otp.
  const findings = check(403, {
    error: 'insufficient_authorization',
    auth_session: 'fresh',
    next: [{ action: 'action:challenge:email:v1', index: 0, identifier: 'ha***@ok***' }],
  });
  assert.deepEqual(findings, [], JSON.stringify(titles(findings)));
});

/* ── it catches what it exists to catch ─────────────────────────────────── */

test('a wrong status for a known error code is a violation', () => {
  const findings = check(400, {
    error: 'insufficient_authorization',
    auth_session: 'x',
    next: [{ action: 'action:verify:otp:v1' }],
  });
  assert.ok(has(findings, 'returned 400, not 403'));
  assert.equal(findings[0].severity, 'violation');
  // The draft is normative on this one, so the detail should say so rather than assert a preference.
  assert.match(findings[0].detail, /MUST respond with the HTTP 403/);
});

test('a session that did not rotate is caught', () => {
  const findings = check(
    403,
    { error: 'insufficient_authorization', auth_session: 'same', next: [{ action: 'action:verify:otp:v1' }] },
    { auth_session: 'same' }
  );
  assert.ok(has(findings, 'did not rotate'));
  assert.ok(findings.find((f) => f.title.includes('rotate')).gap, 'links the recorded gap');
});

test('a continuation missing its session or its next[] is a violation', () => {
  assert.ok(has(check(403, { error: 'insufficient_authorization', next: [{ action: 'a' }] }), 'no auth_session'));
  assert.ok(has(check(403, { error: 'insufficient_authorization', auth_session: 'x' }), 'no next[]'));
});

test('a 5xx says nothing in the contract answers with one', () => {
  const findings = check(500, { error: 'server_error' });
  assert.equal(findings[0].severity, 'gap');
  assert.match(findings[0].detail, /Nothing in the contract answers with a 5xx/);
  // The out-of-order 500 was fixed on the tenant, so a 5xx today is a regression rather than the
  // expected behaviour this advice used to describe.
  assert.match(findings[0].detail, /regression/);
});

test('a consumed session accepted again is the replay gap', () => {
  // Invisible in any one response — the caller has to say the session had been spent. Verified
  // against the live tenant: it still accepts a burned session.
  const accepted = checkResponse({
    request: { body: { auth_session: 'burned', action: 'action:identify:email:v1' } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'new', next: [{ action: 'action:challenge:email:v1', index: 0, identifier: 'x' }] },
    context: { sessionAlreadyUsed: true },
  });
  assert.ok(has(accepted, 'consumed auth_session was accepted'));

  // Rejecting it is the correct behaviour and must not be flagged.
  const rejected = checkResponse({
    request: { body: { auth_session: 'burned' } },
    status: 400,
    body: { error: 'invalid_session' },
    context: { sessionAlreadyUsed: true },
  });
  assert.ok(!has(rejected, 'consumed auth_session was accepted'));
});

test('acceptance is not status < 400 — this protocol succeeds with 403', () => {
  assert.equal(wasAccepted(403, { error: 'insufficient_authorization' }), true);
  assert.equal(wasAccepted(403, { error: 'redirect_to_web' }), true);
  assert.equal(wasAccepted(200, { authorization_code: 'x' }), true);
  assert.equal(wasAccepted(403, { error: 'access_denied' }), false, 'terminal, not accepted');
  assert.equal(wasAccepted(400, { error: 'invalid_request' }), false);
  assert.equal(wasAccepted(500, { error: 'server_error' }), false);
});

test('invalid_grant for a bad session names the code the draft defines', () => {
  const findings = check(400, { error: 'invalid_grant' }, { auth_session: 'stale' });
  assert.ok(has(findings, 'invalid_grant used for a bad auth_session'));
  assert.match(findings.find((f) => f.title.includes('invalid_grant')).detail, /invalid_session/);
});

test('an href with no expires_in is caught', () => {
  const findings = check(403, {
    error: 'redirect_to_web',
    request_uri: 'urn:ietf:params:oauth:request_uri:x',
    auth_session: 'x',
    next: [{ action: 'authn:federated:company-saml:v1', href: 'https://t/authorize?request_uri=x' }],
  }, { code_challenge: 'E9M' });
  assert.ok(has(findings, 'no expires_in'));
});

test('a request_uri issued without PKCE is a violation', () => {
  const findings = check(403, {
    error: 'redirect_to_web',
    request_uri: 'urn:ietf:params:oauth:request_uri:x',
    auth_session: 'x',
    next: [{ action: 'authn:federated:company-saml:v1', href: 'https://t', expires_in: 300 }],
  }, {}); // no code_challenge
  const f = findings.find((x) => x.title.includes('without PKCE'));
  assert.ok(f);
  assert.equal(f.severity, 'violation');
  assert.match(f.detail, /MUST NOT return a request_uri/);
});

test('unknown vocabulary is reported as undocumented, not as a violation', () => {
  // The registry may simply be behind the tenant; that is a different problem from a breach of
  // contract, and conflating them makes the loud one easy to ignore.
  for (const body of [
    { error: 'teapot_required' },
    { error: 'insufficient_authorization', auth_session: 'x', next: [{ action: 'action:verify:otp:v1' }], error_description: 'made_up' },
    { error: 'insufficient_authorization', auth_session: 'x', next: [{ action: 'action:brand:new:v1' }] },
    { error: 'insufficient_authorization', auth_session: 'x', next: [{ action: 'action:verify:otp:v1' }], surprise: 1 },
  ]) {
    const findings = check(body.error === 'teapot_required' ? 400 : 403, body);
    assert.ok(findings.length > 0, JSON.stringify(body));
    assert.ok(
      findings.every((f) => f.severity !== 'violation'),
      `${JSON.stringify(titles(findings))} should not be violations`
    );
  }
});

test('501 explains that the action was offered before it was refused', () => {
  const findings = check(501, { error: 'not_implemented' }, { action: 'action:identify:phone:v1' });
  assert.ok(has(findings, 'negotiates but has no handler'));
  assert.match(findings[0].detail, /advertised in next\[\]/);
});

test('summarise counts by severity', () => {
  const findings = check(400, { error: 'insufficient_authorization', mystery: true });
  const s = summarise(findings);
  assert.ok(s.violation >= 1 && s.undocumented >= 1, JSON.stringify(s));
  assert.equal(summarise([]).violation, undefined);
});

test('a malformed or empty response does not throw', () => {
  for (const body of [undefined, null, 'not json', 42, []]) {
    assert.doesNotThrow(() => checkResponse({ status: 500, body }));
  }
  assert.doesNotThrow(() => checkResponse());
});

test('every error code the checker names is one the registry defines', () => {
  // The detail text lists the documented codes; if it drifts from ERRORS the advice goes stale.
  const findings = check(400, { error: 'teapot_required' });
  for (const code of Object.keys(ERRORS)) {
    assert.ok(findings[0].detail.includes(code), `advice omits ${code}`);
  }
});

/* ── the registry against the modelled calls ────────────────────────────── */

test('what the registry says an action emits is what the calls carry', () => {
  // This found four errors the first time it ran: challenge:email declared `channel` (which
  // belongs to verify:otp, since a challenge descriptor is offered before any code is sent) and
  // three actions omitted `optional` / `complexity` entirely.
  const problems = [];
  for (const a of ACTION_CATALOG) {
    const cap = byId(a.action);
    if (!cap) continue;
    const declared = new Set((cap.emits ?? []).map((e) => e.name));
    const observed = new Set(a.emitsFields.map((f) => f.name));

    for (const f of observed) if (!declared.has(f)) problems.push(`${a.action}: emits ${f}, undeclared`);
    for (const d of declared) if (!observed.has(d)) problems.push(`${a.action}: declares ${d}, never seen`);
  }
  assert.deepEqual(problems, []);
});

test('what the registry says an action takes is what the calls send', () => {
  const problems = [];
  for (const a of ACTION_CATALOG) {
    const cap = byId(a.action);
    if (!cap) continue;
    const declared = new Set((cap.request ?? []).map((r) => r.name));
    for (const f of a.requestFields) {
      if (!declared.has(f.name)) problems.push(`${a.action}: sends ${f.name} (${f.occurrences}×), undeclared`);
    }
  }
  // `phone` on identify:phone is a real divergence between the two models, not a registry slip:
  // the signup model sends `phone`, the registry declares `phone_number`.
  assert.deepEqual(problems, ['action:identify:phone:v1: sends phone (18×), undeclared']);
});
