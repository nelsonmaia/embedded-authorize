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

/**
 * PKCE is mandatory, so the default stand-in request carries it — otherwise every case here would
 * also report a missing challenge and drown out what it is actually testing. The PKCE tests call
 * checkResponse directly.
 */
const PKCE = { code_challenge: 'E9Melhoa2Ow', code_challenge_method: 'S256' };
const check = (status, body, sent = {}) =>
  checkResponse({ request: { body: { ...PKCE, ...sent } }, status, body });

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
  assert.ok(has(findings, 'Wrong status for insufficient_authorization'));
  assert.equal(findings[0].severity, 'violation');
  // The draft is normative on this one, so the detail should say so rather than assert a preference.
  assert.match(findings[0].why, /MUST respond with the HTTP 403/);
  assert.equal(findings[0].expected, '403');
  assert.equal(findings[0].actual, '400');
});

test('a session that did not rotate is caught', () => {
  const findings = check(
    403,
    { error: 'insufficient_authorization', auth_session: 'same', next: [{ action: 'action:verify:otp:v1' }] },
    { auth_session: 'same' }
  );
  assert.ok(has(findings, 'auth_session did not rotate'));
  assert.ok(findings.find((f) => f.title.includes('rotate')).gap, 'links the recorded gap');
});

test('a continuation missing its session or its next[] is a violation', () => {
  assert.ok(has(check(403, { error: 'insufficient_authorization', next: [{ action: 'a' }] }), 'carries no auth_session'));
  assert.ok(has(check(403, { error: 'insufficient_authorization', auth_session: 'x' }), 'carries no next[]'));
});

test('a 5xx says nothing in the contract answers with one', () => {
  const findings = check(500, { error: 'server_error' });
  assert.equal(findings[0].severity, 'gap');
  assert.match(findings[0].why, /Nothing in the contract answers with a 5xx/);
  // The out-of-order 500 was fixed on the tenant, so a 5xx today is a regression rather than the
  // expected behaviour this advice used to describe.
  assert.match(findings[0].why, /regression/);
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
  assert.ok(has(accepted, 'spent auth_session was accepted'));

  // Rejecting it is the correct behaviour and must not be flagged.
  const rejected = checkResponse({
    request: { body: { auth_session: 'burned' } },
    status: 400,
    body: { error: 'invalid_session' },
    context: { sessionAlreadyUsed: true },
  });
  assert.ok(!has(rejected, 'spent auth_session was accepted'));
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
  assert.ok(has(findings, 'reported as invalid_grant'));
  assert.equal(findings.find((f) => f.title.includes('invalid_grant')).expected, 'invalid_session');
});

test('an href with no expires_in is caught', () => {
  const findings = check(403, {
    error: 'redirect_to_web',
    request_uri: 'urn:ietf:params:oauth:request_uri:x',
    auth_session: 'x',
    next: [{ action: 'authn:federated:company-saml:v1', href: 'https://t/authorize?request_uri=x' }],
  }, { code_challenge: 'E9M' });
  assert.ok(has(findings, 'href with no expires_in'));
});

test('a request_uri issued without PKCE is a violation', () => {
  // Unreachable through the spec engine now that PKCE is mandatory, but a tenant that does not
  // enforce it can still produce this, and the draft is explicit that it must not.
  const findings = checkResponse({
    request: { body: { auth_session: 'a', action: 'authn:federated:company-saml:v1' } },
    status: 403,
    body: {
      error: 'redirect_to_web',
      request_uri: 'urn:ietf:params:oauth:request_uri:x',
      auth_session: 'x',
      next: [{ action: 'authn:federated:company-saml:v1', href: 'https://t', expires_in: 300 }],
    },
  });
  const f = findings.find((x) => x.title.includes('without PKCE'));
  assert.ok(f, JSON.stringify(titles(findings)));
  assert.equal(f.severity, 'violation');
  assert.match(f.why, /MUST NOT return a request_uri/);
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
  assert.ok(has(findings, 'has no handler behind it'));
  assert.match(findings[0].why, /advertised in next\[\]/);
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
    assert.ok(findings[0].expected.includes(code), `advice omits ${code}`);
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

test('a challenge withdrawn while its code is outstanding is caught', () => {
  // Missed on the first live run: the tenant answered a challenge with verify:otp ALONE and
  // nothing flagged it, even though the settled contract keeps the challenge offered so another
  // code can be sent.
  const withdrawn = checkResponse({
    request: { body: { action: 'action:challenge:email:v1' } },
    status: 403,
    body: {
      error: 'insufficient_authorization',
      auth_session: 'fresh',
      next: [{ action: 'action:verify:otp:v1', channel: 'email', identifier: 'ha***@ok***' }],
    },
    context: { declared: ['action:challenge:email:v1', 'action:verify:otp:v1'] },
  });
  assert.ok(has(withdrawn, 'next[] is missing action:challenge:email:v1'));
  const f = withdrawn.find((x) => x.title.includes('is missing'));
  assert.ok(f.gap, 'links the recorded gap');
  // The finding shows the difference itself, not a description of it.
  assert.equal(f.actual, '["action:verify:otp:v1"]');
  assert.equal(f.expected, '["action:verify:otp:v1","action:challenge:email:v1"]');
  assert.match(f.why, /restart the whole flow/);

  // Keeping it on offer is the settled behaviour and must be silent.
  const kept = checkResponse({
    request: { body: { action: 'action:challenge:email:v1' } },
    status: 403,
    body: {
      error: 'insufficient_authorization',
      auth_session: 'fresh',
      next: [
        { action: 'action:verify:otp:v1', channel: 'email', identifier: 'ha***@ok***' },
        { action: 'action:challenge:email:v1', index: 0, identifier: 'ha***@ok***' },
      ],
    },
    context: { declared: ['action:challenge:email:v1', 'action:verify:otp:v1'] },
  });
  assert.deepEqual(kept, [], JSON.stringify(titles(kept)));
});

test('a capability the client never declared is correctly absent', () => {
  // Flagging this would be noise: negotiation is an intersection, so an undeclared action is
  // supposed to be missing.
  const findings = checkResponse({
    request: { body: { ...PKCE } },
    status: 403,
    body: {
      error: 'insufficient_authorization',
      auth_session: 'fresh',
      next: [{ action: 'action:verify:otp:v1', channel: 'email', identifier: 'x' }],
    },
    context: { declared: ['action:verify:otp:v1'] },
  });
  assert.deepEqual(findings, [], JSON.stringify(titles(findings)));
});

test('the phone channel expects the phone challenge back', () => {
  const findings = checkResponse({
    request: { body: { ...PKCE } },
    status: 403,
    body: {
      error: 'insufficient_authorization',
      auth_session: 'fresh',
      next: [{ action: 'action:verify:otp:v1', channel: 'text', identifier: '+1***67' }],
    },
    context: { declared: ['action:challenge:phone:v1', 'action:verify:otp:v1'] },
  });
  assert.ok(has(findings, 'next[] is missing action:challenge:phone:v1'));
});

test('the spec engine keeps the challenge, so it would pass its own check', async () => {
  // The end state and the checker have to agree, or one of them is wrong.
  const { freshState, initiate, submit } = await import('../src/engine/engine.js');
  const { CONNECTION_PRESETS } = await import('../src/data/spec.js');
  const caps = ['action:identify:email:v1', 'action:challenge:email:v1', 'action:verify:otp:v1'];

  const state = freshState({
    connection: CONNECTION_PRESETS.find((c) => c.id === 'db-email-otp'),
    declaredCaps: caps,
  });
  initiate(state, {});
  submit(state, 'action:identify:email:v1', { email: 'hazel.nutt@okta.com' });
  const challenged = submit(state, 'action:challenge:email:v1', {});

  const findings = checkResponse({
    request: { body: { action: 'action:challenge:email:v1' } },
    status: challenged.status,
    body: challenged.body,
    context: { declared: caps },
  });
  assert.deepEqual(findings, [], JSON.stringify(titles(findings)));
});

test('every finding shows the difference, not just prose about it', () => {
  // The whole point of the shape: `expected` and `actual` are the two values side by side, and
  // `why` is the consequence rather than a restatement of the title.
  const samples = [
    check(400, { error: 'insufficient_authorization', auth_session: 'x', next: [{ action: 'action:verify:otp:v1' }] }),
    check(500, { error: 'server_error' }),
    check(200, { authorization_code: 'x', extra: 1 }),
    check(403, { error: 'insufficient_authorization', auth_session: 'x', next: [{ action: 'action:verify:otp:v1' }], mystery: 1 }),
  ].flat();

  assert.ok(samples.length >= 4);
  for (const f of samples) {
    assert.ok(f.title?.length > 5, `no title: ${JSON.stringify(f)}`);
    assert.ok(f.why?.length > 20, `no why: ${f.title}`);
    assert.ok(f.expected || f.actual, `${f.title} shows no difference`);
    assert.notEqual(f.why, f.title, `${f.title} restates itself`);
    // `detail` was the old single prose field; nothing should still be producing it.
    assert.equal(f.detail, undefined, `${f.title} still uses the old shape`);
  }
});

test('a flow started without PKCE is flagged', () => {
  // Verified against the live tenant, which accepts it and runs through to a code.
  const noPkce = checkResponse({
    request: { body: { client_id: 'x', connection: 'db', capabilities: ['action:identify:email:v1'] } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'a', next: [{ action: 'action:identify:email:v1' }] },
  });
  assert.ok(has(noPkce, 'started with no PKCE challenge'));
  assert.match(noPkce.find((f) => f.title.includes('PKCE')).why, /public clients/);

  // With it, nothing to say.
  const withPkce = checkResponse({
    request: { body: { client_id: 'x', code_challenge: 'E9M', code_challenge_method: 'S256' } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'a', next: [{ action: 'action:identify:email:v1' }] },
  });
  assert.deepEqual(withPkce, [], JSON.stringify(titles(withPkce)));
});

test('plain is flagged even when a challenge was sent', () => {
  const findings = checkResponse({
    request: { body: { code_challenge: 'abc', code_challenge_method: 'plain' } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'a', next: [{ action: 'action:identify:email:v1' }] },
  });
  assert.ok(has(findings, 'code_challenge_method plain was accepted'));
});

test('continuations are not mistaken for a missing PKCE challenge', () => {
  // Only the initiate call carries code_challenge; flagging every later call would be noise.
  const findings = checkResponse({
    request: { body: { auth_session: 'a', action: 'action:identify:email:v1', email: 'x@y.z' } },
    status: 403,
    body: { error: 'insufficient_authorization', auth_session: 'b', next: [{ action: 'action:challenge:email:v1', index: 0, identifier: 'x' }] },
  });
  assert.ok(!has(findings, 'PKCE'), JSON.stringify(titles(findings)));
});

test('a tenant that rejects code_challenge is reported separately', () => {
  // "You did not send PKCE" and "you cannot send PKCE" need different work, so they are different
  // findings. Verified on the live tenant: the initiate schema is additionalProperties: false and
  // defines no PKCE parameters.
  const findings = checkResponse({
    request: { body: { client_id: 'x', code_challenge: 'E9M', code_challenge_method: 'S256' } },
    status: 400,
    body: {
      error: 'invalid_request',
      error_description: 'data must NOT have additional properties, and/or data must match exactly one schema in oneOf',
    },
  });
  const f = findings.find((x) => x.title.includes('rejects code_challenge'));
  assert.ok(f, JSON.stringify(titles(findings)));
  assert.ok(f.gap, 'links the recorded gap');
  // The consequence that matters most is not the missing protection but the blocked design.
  assert.match(f.why, /request_uri MUST NOT be returned/);
});
