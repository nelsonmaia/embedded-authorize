/**
 * Check a real tenant response against the contract.
 *
 * Live mode exists to show what a tenant does today, and the interesting part is where that
 * differs from what the documents say. Reading two JSON blobs side by side and spotting a missing
 * `expires_in` or an `auth_session` that failed to rotate is exactly the kind of thing a person
 * does badly and a function does well.
 *
 * A pure function over one exchange, so it is testable without a network and cannot depend on
 * anything but what came back. It never modifies the response — live mode shows the tenant's
 * answer verbatim, and these are annotations beside it.
 *
 * Three severities, and the distinction matters:
 *   violation     contradicts the draft or the documented contract
 *   gap           a deviation already recorded in KNOWN_GAPS — expected, not news
 *   undocumented  real behaviour the registry has no entry for; possibly the registry is stale
 */
import {
  ERRORS,
  ERROR_DESCRIPTIONS,
  CAPABILITIES,
  KNOWN_GAPS,
  byId,
  isFederatedAction,
} from './spec.js';

const DESCRIPTION_CODES = new Set(ERROR_DESCRIPTIONS.map((e) => e.code));
const KNOWN_ACTIONS = new Set(CAPABILITIES.map((c) => c.id));
const gapTitled = (fragment) => KNOWN_GAPS.find((g) => g.title.includes(fragment))?.title;

/**
 * Did the server ACCEPT this call?
 *
 * Not `status < 400`: the whole protocol answers a successful step with 403. Acceptance means the
 * pipeline advanced — a continuation, a browser handoff, or the final code — as opposed to the
 * request being rejected for its own sake.
 */
export const wasAccepted = (status, body) =>
  status === 200 ||
  body?.error === 'insufficient_authorization' ||
  body?.error === 'redirect_to_web';

/** Fields the contract defines at the top level of a response. */
const TOP_LEVEL = new Set([
  'error',
  'error_description',
  'error_uri',
  'auth_session',
  'next',
  'request_uri',
  'expires_in',
  'authorization_code',
]);

const j = (v) => JSON.stringify(v);

/**
 * @param {{
 *   request?: { body?: object },
 *   status: number,
 *   body?: object,
 *   context?: { sessionAlreadyUsed?: boolean, declared?: string[] },
 * }} exchange
 * @returns {{
 *   severity: string, title: string, expected?: string, actual?: string, why: string, gap?: string
 * }[]}
 *
 * A finding says what was expected, what came back, and what it costs — three separate fields,
 * because prose describing a difference is harder to act on than the two values side by side.
 * `title` names what is wrong in one line; `why` is the consequence, never a restatement of it.
 */
export function checkResponse({ request, status, body, context } = {}) {
  const found = [];
  const add = (f) => found.push(f);

  if (!body || typeof body !== 'object') return found;

  const sent = request?.body ?? {};
  const { error, error_description: desc, next, auth_session: session } = body;
  const actions = (Array.isArray(next) ? next : []).map((n) => n?.action).filter(Boolean);

  /* ── the error code and its status ─────────────────────────────────────── */

  if (error) {
    const known = ERRORS[error];
    if (!known) {
      add({
        severity: 'undocumented',
        title: `Unknown error code: ${error}`,
        expected: `one of ${Object.keys(ERRORS).join(', ')}`,
        actual: error,
        why: 'Either the tenant returns something the contract does not describe, or the registry is behind it.',
      });
    } else if (known.http !== status) {
      add({
        severity: 'violation',
        title: `Wrong status for ${error}`,
        expected: `${known.http}`,
        actual: `${status}`,
        why:
          error === 'insufficient_authorization'
            ? 'The draft is normative: "The authorization server MUST respond with the HTTP 403 ' +
              '(Forbidden) status code." A client keying on the status will not recognise this as a ' +
              'continuation.'
            : `The contract pairs ${error} with ${known.http}.`,
      });
    }
  }

  // 501 not_implemented is its own condition, handled below.
  if (status >= 500 && error !== 'not_implemented') {
    add({
      severity: 'gap',
      title: `The endpoint answered ${status}`,
      expected: 'a 4xx naming what was wrong with the request',
      actual: `${status}${error ? ` ${error}` : ''}`,
      why:
        'Nothing in the contract answers with a 5xx. An action outside the previous next[] used to ' +
        'land here; that was fixed and now returns 400 invalid_request, so a 5xx today is either a ' +
        'genuine fault or a regression of that fix.',
      gap: gapTitled('Out-of-order action'),
    });
  }

  if (error === 'invalid_grant' && sent.auth_session) {
    add({
      severity: 'gap',
      title: 'A bad auth_session reported as invalid_grant',
      expected: 'invalid_session',
      actual: 'invalid_grant',
      why:
        'The draft defines invalid_session for exactly this: "The provided auth_session is invalid, ' +
        'expired, revoked, or otherwise not acceptable." invalid_grant is RFC 6749\'s code for a bad ' +
        'authorization grant, which an auth_session is not — so a client cannot tell a dead session ' +
        'from a rejected grant.',
    });
  }

  if (error === 'not_implemented') {
    add({
      severity: 'gap',
      title: `${sent.action ?? 'The action'} has no handler behind it`,
      expected: 'the action to run, having been offered in next[]',
      actual: '501 not_implemented',
      why:
        'It was advertised in next[] and accepted into the allow-list, then refused. A client that ' +
        'trusts next[] — which is the contract — cannot avoid this.',
      gap: gapTitled('identify:phone'),
    });
  }

  /* ── error_description vocabulary ──────────────────────────────────────── */

  if (desc && status === 403 && !DESCRIPTION_CODES.has(desc)) {
    add({
      severity: 'undocumented',
      title: `Unknown error_description: ${desc}`,
      expected: `one of ${[...DESCRIPTION_CODES].join(', ')}`,
      actual: desc,
      why: 'On a 403 this is a coded value a client switches on, so an unlisted one has no defined meaning.',
    });
  }

  /* ── continuation shape ────────────────────────────────────────────────── */

  if (error === 'insufficient_authorization') {
    if (!session) {
      add({
        severity: 'violation',
        title: 'The continuation carries no auth_session',
        expected: 'a rotated auth_session',
        actual: 'absent',
        why: 'Without one the flow cannot continue and the client has to restart from the beginning.',
      });
    }
    if (!Array.isArray(next) || next.length === 0) {
      add({
        severity: 'violation',
        title: 'The continuation carries no next[]',
        expected: 'at least one action',
        actual: Array.isArray(next) ? '[]' : 'absent',
        why:
          'next[] is both the response and the server-side allow-list, so an empty one leaves the ' +
          'client with nothing it is permitted to send.',
      });
    }
  }

  if (context?.sessionAlreadyUsed && wasAccepted(status, body)) {
    add({
      severity: 'gap',
      title: 'A spent auth_session was accepted',
      expected: '400 invalid_session',
      actual: `${status} ${error ?? 'accepted'}`,
      why:
        'This exact session had already been used on an earlier successful call and should have been ' +
        'burned by it. Because it still works, any step can be replayed — which is what turns ' +
        'challenge:email into an OTP-bombing vector with none of the protections a real resend ' +
        'would carry.',
      gap: gapTitled('auth_session replay'),
    });
  }

  if (session && sent.auth_session && session === sent.auth_session) {
    add({
      severity: 'gap',
      title: 'auth_session did not rotate',
      expected: 'a value different from the one sent',
      actual: 'the same value came back',
      why:
        'Each accepted request should consume the session it was presented with. The same value ' +
        'returning means a consumed session stays valid.',
      gap: gapTitled('auth_session replay'),
    });
  }

  /* ── PKCE ──────────────────────────────────────────────────────────────── */

  // An initiate is the call with no auth_session: it is what creates one.
  const isInitiate = !sent.auth_session && !sent.action;
  if (isInitiate && !sent.code_challenge && wasAccepted(status, body)) {
    add({
      severity: 'gap',
      title: 'A flow started with no PKCE challenge',
      expected: '400 invalid_request — code_challenge is required',
      actual: `${status} ${error ?? 'accepted'}`,
      why:
        'This endpoint serves public clients, which hold no secret, and this flow will end in an ' +
        'authorization code. Issued without a challenge, that code is redeemable by whoever ' +
        'intercepts it — on a native app, any other app registered for the same redirect scheme.',
      gap: gapTitled('PKCE is not enforced'),
    });
  }
  // The stronger case: the client tried and was refused. Worth separating, because "you did not
  // send PKCE" and "you cannot send PKCE" call for completely different work.
  if (
    sent.code_challenge &&
    status === 400 &&
    /additional propert/i.test(desc ?? '')
  ) {
    add({
      severity: 'gap',
      title: 'The endpoint rejects code_challenge',
      expected: 'the challenge to be accepted and sealed into the session',
      actual: `400 ${desc}`,
      why:
        'The request schema is additionalProperties: false and defines no PKCE parameters, so a ' +
        'client cannot opt into protecting its own authorization code. It also makes a draft rule ' +
        'unreachable: a request_uri MUST NOT be returned to a client that sent no code_challenge, ' +
        'and no client can send one — so no redirect_to_web response may legally carry the ' +
        'reference the federation design is built on.',
      gap: gapTitled('PKCE cannot be sent'),
    });
  }

  if (isInitiate && sent.code_challenge_method && sent.code_challenge_method !== 'S256') {
    add({
      severity: 'gap',
      title: `code_challenge_method ${sent.code_challenge_method} was accepted`,
      expected: 'S256',
      actual: sent.code_challenge_method,
      why:
        '`plain` sends the verifier itself as the challenge, so anyone who can read the initiate ' +
        'request can redeem the code. It protects nothing here.',
      gap: gapTitled('PKCE cannot be sent'),
    });
  }

  /* ── redirect_to_web and PKCE ──────────────────────────────────────────── */

  if (error === 'redirect_to_web') {
    const pkce = !!sent.code_challenge;
    if (body.request_uri && !pkce) {
      add({
        severity: 'violation',
        title: 'request_uri issued without PKCE',
        expected: 'no request_uri, because the request carried no code_challenge',
        actual: body.request_uri,
        why:
          'The draft: "If the client does not include a PKCE code_challenge in the initial ' +
          'authorization challenge request, the authorization server MUST NOT return a request_uri ' +
          'in the redirect_to_web error response, as that would effectively be the same as a PAR ' +
          'request without PKCE."',
      });
    }
    if (!body.request_uri && pkce) {
      add({
        severity: 'undocumented',
        title: 'No request_uri, though PKCE was sent',
        expected: 'a request_uri, which the code_challenge made legal to issue',
        actual: 'absent',
        why:
          'Permitted — the draft has the client start its own authorization code flow instead — but ' +
          'the reference could have been issued here.',
      });
    }
  }

  /* ── next[] entries ────────────────────────────────────────────────────── */

  for (const entry of Array.isArray(next) ? next : []) {
    const action = entry?.action;
    if (!action) {
      add({
        severity: 'violation',
        title: 'A next[] entry with no action',
        expected: 'every entry to name an action',
        actual: j(entry),
        why: 'The client has nothing to send for this option.',
      });
      continue;
    }

    const cap = byId(action);
    if (!cap && !KNOWN_ACTIONS.has(action)) {
      add({
        severity: 'undocumented',
        title: `Unknown action offered: ${action}`,
        expected: 'an action in the capability registry',
        actual: action,
        why: isFederatedAction(action)
          ? 'A connection-specialised federation action the registry cannot resolve.'
          : 'The registry has no capability with this id, so nothing describes what to send.',
      });
      continue;
    }

    const declaredFields = new Set((cap?.emits ?? []).map((e) => e.name));
    const extra = Object.keys(entry).filter((f) => f !== 'action' && !declaredFields.has(f));
    if (extra.length) {
      add({
        severity: 'undocumented',
        title: `${action} carries ${extra.join(', ')}`,
        expected: declaredFields.size ? `action, ${[...declaredFields].join(', ')}` : 'action only',
        actual: Object.keys(entry).join(', '),
        why: 'The registry does not list these among the fields this action emits on its descriptor.',
      });
    }

    if (entry.href && entry.expires_in === undefined) {
      add({
        severity: 'gap',
        title: `${action} hands back an href with no expires_in`,
        expected: 'href, expires_in',
        actual: 'href',
        why:
          'The reference behind the href has a TTL. Without it a client cannot tell an expired href ' +
          'from a broken one, or refresh before the user meets a dead page.',
        gap: gapTitled('Web-leg lifetimes'),
      });
    }
  }

  /* ── the challenge should survive its own code ─────────────────────────── */

  const verify = (Array.isArray(next) ? next : []).find((n) => n?.action === 'action:verify:otp:v1');
  if (verify) {
    const challenge = ['phone', 'text', 'voice'].includes(verify.channel)
      ? 'action:challenge:phone:v1'
      : 'action:challenge:email:v1';

    // Only meaningful if the client asked for it — negotiation is an intersection, so an
    // undeclared capability is correctly absent and flagging it would be noise.
    const declared = new Set(context?.declared ?? []);
    if (declared.has(challenge) && !actions.includes(challenge)) {
      add({
        severity: 'gap',
        title: `next[] is missing ${challenge}`,
        expected: j([...actions, challenge]),
        actual: j(actions),
        why:
          'A code is outstanding, so the challenge stays on offer for a resend. With it withdrawn, ' +
          'the only action that could send another code is not in the allow-list — a user whose ' +
          'code never arrived has to restart the whole flow.',
        gap: gapTitled('challenge is withdrawn'),
      });
    }
  }

  /* ── success shape ─────────────────────────────────────────────────────── */

  if (status === 200) {
    if (!body.authorization_code) {
      add({
        severity: 'violation',
        title: 'A 200 with no authorization_code',
        expected: 'authorization_code',
        actual: Object.keys(body).join(', ') || 'an empty body',
        why: 'The final response carries the code; there is nothing else for the client to exchange.',
      });
    }
    const extra = Object.keys(body).filter((k) => k !== 'authorization_code');
    if (extra.length) {
      add({
        severity: 'undocumented',
        title: `The final response also carries ${extra.join(', ')}`,
        expected: 'authorization_code alone',
        actual: Object.keys(body).join(', '),
        why: 'The contract has the final response carry the code and nothing else.',
      });
    }
  }

  /* ── anything else at the top level ────────────────────────────────────── */

  for (const key of Object.keys(body)) {
    if (TOP_LEVEL.has(key)) continue;
    add({
      severity: 'undocumented',
      title: `Undefined top-level field: ${key}`,
      expected: [...TOP_LEVEL].join(', '),
      actual: key,
      why: 'The contract does not define this on a response, so no client will be reading it.',
    });
  }

  return found;
}

/** Counts by severity, for a summary line. */
export const summarise = (findings = []) =>
  findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
