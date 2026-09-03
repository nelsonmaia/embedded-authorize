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

/**
 * @param {{
 *   request?: { body?: object },
 *   status: number,
 *   body?: object,
 *   context?: { sessionAlreadyUsed?: boolean },
 * }} exchange
 * @returns {{ severity: string, title: string, detail: string, gap?: string }[]}
 */
export function checkResponse({ request, status, body, context } = {}) {
  const found = [];
  const add = (severity, title, detail, gap) => found.push({ severity, title, detail, gap });

  if (!body || typeof body !== 'object') return found;

  const sent = request?.body ?? {};
  const { error, error_description: desc, next, auth_session: session } = body;

  /* ── the error code and its status ─────────────────────────────────────── */

  if (error) {
    const known = ERRORS[error];
    if (!known) {
      add(
        'undocumented',
        `error: ${error} is not in the registry`,
        'The contract documents ' +
          Object.keys(ERRORS).join(', ') +
          '. Either the tenant returns something undocumented, or spec.js is behind.'
      );
    } else if (known.http !== status) {
      add(
        'violation',
        `${error} returned ${status}, not ${known.http}`,
        error === 'insufficient_authorization'
          ? 'The draft is normative here: "The authorization server MUST respond with the HTTP 403 ' +
            '(Forbidden) status code."'
          : `The contract pairs ${error} with ${known.http}.`
      );
    }
  }

  // 501 not_implemented is its own condition, handled below — a negotiated action with nothing
  // behind it, not the allow-list refusing an out-of-order call.
  if (status >= 500 && error !== 'not_implemented') {
    add(
      'gap',
      `${status} from the endpoint`,
      'Nothing in the contract answers with a 5xx. An action outside the previous next[] used to ' +
        'land here; that was fixed and now returns 400 invalid_request, so a 5xx today is either a ' +
        'genuine fault or a regression of that fix.',
      gapTitled('Out-of-order action')
    );
  }

  if (error === 'invalid_grant' && sent.auth_session) {
    add(
      'gap',
      'invalid_grant used for a bad auth_session',
      'The draft defines invalid_session for exactly this: "The provided auth_session is invalid, ' +
        'expired, revoked, or otherwise not acceptable." invalid_grant is RFC 6749\'s code for a ' +
        'bad authorization grant, which an auth_session is not.'
    );
  }

  if (error === 'not_implemented') {
    add(
      'gap',
      `${sent.action ?? 'The action'} negotiates but has no handler`,
      'It was advertised in next[] and accepted into the allow-list, then resolved to 501. A ' +
        'client that trusts next[] cannot avoid this.',
      gapTitled('identify:phone')
    );
  }

  /* ── error_description vocabulary ──────────────────────────────────────── */

  if (desc && status === 403 && !DESCRIPTION_CODES.has(desc)) {
    add(
      'undocumented',
      `error_description: ${desc} is not in the vocabulary`,
      'On a 403 this is a coded value a client switches on, and the documented set is ' +
        [...DESCRIPTION_CODES].join(', ') + '.'
    );
  }

  /* ── continuation shape ────────────────────────────────────────────────── */

  if (error === 'insufficient_authorization') {
    if (!session) {
      add(
        'violation',
        'A continuation with no auth_session',
        'Every non-final response carries a rotated session; without one the flow cannot continue ' +
          'and the client has to restart.'
      );
    }
    if (!Array.isArray(next) || next.length === 0) {
      add(
        'violation',
        'A continuation with no next[]',
        'next[] is both the response and the server-side allow-list. An empty one leaves the ' +
          'client with nothing it is permitted to send.'
      );
    }
  }

  // Only the caller knows whether this session had already been spent — a single response cannot
  // show it. D2 decision #4 says an accepted request consumes its session; if a consumed one still
  // works, every step of the flow is replayable, and challenge:email becomes an unrate-limited
  // resend. This is the most consequential thing live mode can demonstrate.
  if (context?.sessionAlreadyUsed && wasAccepted(status, body)) {
    add(
      'gap',
      'A consumed auth_session was accepted',
      'This exact session had already been used on an earlier successful call. It should have been ' +
        'burned by that call and rejected here. Because it was not, any step can be replayed — ' +
        'which is what turns challenge:email into an OTP-bombing vector with none of the ' +
        'protections a real resend would carry.',
      gapTitled('auth_session replay')
    );
  }

  if (session && sent.auth_session && session === sent.auth_session) {
    add(
      'gap',
      'auth_session did not rotate',
      'Each accepted request should consume the session it was presented with and answer with a ' +
        'fresh one. The same value coming back means a consumed session stays valid, which is what ' +
        'makes challenge:email replayable as an unrate-limited resend.',
      gapTitled('auth_session replay')
    );
  }

  /* ── redirect_to_web and PKCE ──────────────────────────────────────────── */

  if (error === 'redirect_to_web') {
    const pkce = !!sent.code_challenge;
    if (body.request_uri && !pkce) {
      add(
        'violation',
        'request_uri returned without PKCE',
        'The draft: "If the client does not include a PKCE code_challenge in the initial ' +
          'authorization challenge request, the authorization server MUST NOT return a request_uri ' +
          'in the redirect_to_web error response."'
      );
    }
    if (!body.request_uri && pkce) {
      add(
        'undocumented',
        'redirect_to_web without a request_uri',
        'Permitted — the draft has the client start its own authorization code flow instead — but ' +
          'a code_challenge was sent, so a reference could legally have been issued.'
      );
    }
  }

  /* ── next[] entries ────────────────────────────────────────────────────── */

  for (const entry of Array.isArray(next) ? next : []) {
    const action = entry?.action;
    if (!action) {
      add('violation', 'A next[] entry with no action', `Entry: ${JSON.stringify(entry)}`);
      continue;
    }

    const cap = byId(action);
    if (!cap && !KNOWN_ACTIONS.has(action)) {
      add(
        'undocumented',
        `next[] offers ${action}`,
        isFederatedAction(action)
          ? 'A connection-specialised federation action the registry cannot resolve.'
          : 'The registry has no capability with this id.'
      );
      continue;
    }

    const declared = new Set((cap?.emits ?? []).map((e) => e.name));
    for (const field of Object.keys(entry)) {
      if (field === 'action' || declared.has(field)) continue;
      add(
        'undocumented',
        `${action} carries ${field}`,
        `The registry does not list ${field} among the fields this action emits on its descriptor.`
      );
    }

    if (entry.href && entry.expires_in === undefined) {
      add(
        'gap',
        `${action} hands back an href with no expires_in`,
        'The reference behind it has a TTL. Without it a client cannot tell an expired href from a ' +
          'broken one, or refresh before the user meets a dead page.',
        gapTitled('Web-leg lifetimes')
      );
    }
  }

  /* ── success shape ─────────────────────────────────────────────────────── */

  if (status === 200) {
    if (!body.authorization_code) {
      add('violation', 'A 200 with no authorization_code', 'The final response carries the code and nothing else.');
    }
    const extra = Object.keys(body).filter((k) => k !== 'authorization_code');
    if (extra.length) {
      add(
        'undocumented',
        `The final response carries ${extra.join(', ')}`,
        'The contract has it carry authorization_code alone.'
      );
    }
  }

  /* ── anything else at the top level ────────────────────────────────────── */

  for (const key of Object.keys(body)) {
    if (TOP_LEVEL.has(key)) continue;
    add('undocumented', `Top-level ${key}`, `The contract does not define ${key} on a response.`);
  }

  return found;
}

/** Counts by severity, for a summary line. */
export const summarise = (findings = []) =>
  findings.reduce((acc, f) => ({ ...acc, [f.severity]: (acc[f.severity] ?? 0) + 1 }), {});
