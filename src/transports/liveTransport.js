/**
 * liveTransport — real HTTP against a real tenant.
 *
 * Goes through `POST /__tenant`, the Vite dev middleware, for the same reason Postman works when
 * a browser doesn't: the request is made server-side, so `POST /e/authorize`'s missing CORS
 * headers are irrelevant. See scripts/vite-plugin-tenant-proxy.js.
 *
 * This transport never consults the spec to BUILD a response. If a call fails, it reports the
 * failure — it does not substitute a documented one, because then you would not be testing your
 * tenant. It does compare the answer against the contract afterwards and attach what differs;
 * that is annotation beside the response, never a change to it.
 */
import { byId } from '../data/spec.js';
import { checkResponse, wasAccepted } from '../data/conformance.js';
import { explainMissingProxy, probeServer } from '../data/serverProbe.js';
import { TENANT } from '../data/endpoints.js';


/* The bare host of whatever was typed in the domain box; the proxy does the same before it dials. */
const hostOf = (v) =>
  String(v ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');

const SECRETS = ['password', 'recovery_code', 'refresh_token', 'access_token'];

function forDisplay(body) {
  const out = { ...body };
  for (const k of SECRETS) if (out[k] != null) out[k] = '••••••••';
  return out;
}

export function liveTransport({ tenant, capabilities }) {
  let authSession = null;
  /* What the client declared at initiate. Some checks turn on it: a capability that was never
     asked for is correctly absent from next[], and flagging that would be noise. */
  let declared = [...capabilities];
  /* Sessions this client has already spent on a successful call. Replay is invisible in any one
     response, so it is tracked here and handed to the checker. */
  const spent = new Set();
  let authorizationCode = null;
  let sentCodeChallenge = false;
  /* What /oauth/token last handed back. The refresh token is what MRRT trades for a token aimed
     at a different API; the access token is what that API is then called with. */
  let refreshToken = null;
  let accessToken = null;

  async function call(path, body, { method = 'POST', authorization } = {}) {
    let res;
    try {
      res = await fetch(TENANT(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          domain: tenant.domain.trim(),
          path,
          method,
          body,
          ...(authorization ? { authorization } : {}),
        }),
      });
    } catch (e) {
      return { ok: false, error: 'proxy_unreachable', detail: e.message };
    }

    /* The proxy answers JSON whatever happens, so anything else means we did not reach it. A
       static host serving a built app answers a POST to an unknown path with 405 and an HTML
       error page; parsing that as JSON reports a syntax error, which describes the symptom and
       hides the cause.

       Which cause it is decides the fix, so ask: /__health is a route nothing static can fake. */
    try {
      return await res.json();
    } catch {
      const probe = await probeServer();
      const detail = explainMissingProxy(probe, res.status);

      // The browser console is where someone looks first when a deployed page misbehaves, and it
      // had nothing to say about this. Now it names the route, the verdict and the fix.
      // eslint-disable-next-line no-console
      console.error(
        `[embedded-authorize] POST /__tenant → ${res.status}, and no server answered /__health.\n` +
          `${detail}\nProbe: ${JSON.stringify(probe)}`
      );

      return { ok: false, error: 'no_proxy', detail };
    }
  }

  const wrap = (sent, env, path = '/e/authorize', method = 'POST') => {
    if (!env.ok) {
      return {
        request: { method, path, body: forDisplay(sent) },
        status: 0,
        body: {},
        error: `${env.error}${env.detail ? ` — ${env.detail}` : ''}`,
      };
    }
    // Held for the MRRT step, which needs the refresh token from here and the access token from there.
    if (path === '/oauth/token') {
      if (env.body?.refresh_token) refreshToken = env.body.refresh_token;
      if (env.body?.access_token) accessToken = env.body.access_token;
    }
    const replayed = !!sent.auth_session && spent.has(sent.auth_session);
    if (sent.auth_session && wasAccepted(env.status, env.body)) spent.add(sent.auth_session);
    if (env.body?.auth_session) authSession = env.body.auth_session;
    if (env.body?.authorization_code) authorizationCode = env.body.authorization_code;

    const exchange = {
      context: { sessionAlreadyUsed: replayed, declared },
      // The UNREDACTED body is what the checker sees: it needs to know whether a code_challenge
      // was sent, and redaction only exists so the screen does not echo a password back.
      request: { method, path, body: sent },
      status: env.status,
      body: env.body,
    };

    return {
      request: { method, path, body: forDisplay(sent) },
      status: env.status,
      body: env.body,
      durationMs: env.durationMs,
      // The contract covers /e/authorize only; the token and My Account calls are not judged by it.
      findings: path === '/e/authorize' ? checkResponse(exchange) : [],
    };
  };

  return {
    kind: 'live',
    isLive: true,

    /**
     * `body` is what the user typed and is sent verbatim — this is a real request to their tenant,
     * so nothing here second-guesses it.
     *
     * The seed deliberately omits code_challenge even though the end-state spec requires it: the
     * endpoint's schema is `additionalProperties: false` and has no PKCE parameters, so sending one
     * is a 400 and the console would fail on its first click. The checker reports the absence
     * instead, which is the honest thing to show.
     */
    async start(body) {
      const sent =
        body ?? {
          client_id: tenant.clientId.trim(),
          connection: tenant.connection.trim(),
          capabilities: [...capabilities],
          ...(tenant.audience?.trim() ? { audience: tenant.audience.trim() } : {}),
          ...(tenant.scope?.trim() ? { scope: tenant.scope.trim() } : {}),
        };
      authSession = null;
      spent.clear();
      // Read from what was actually sent — the payload is editable, so the seed is only a default.
      if (Array.isArray(sent.capabilities)) declared = [...sent.capabilities];
      sentCodeChallenge = !!sent.code_challenge;
      authorizationCode = null;
      return wrap(sent, await call('/e/authorize', sent));
    },

    async send(body) {
      // auth_session is threaded from the live response unless the user pinned their own.
      // client_id rides on every call now, so it is threaded like auth_session: defaulted from
      // the tenant bar, overridden by whatever the payload actually holds.
      const sent = {
        auth_session: body.auth_session ?? authSession,
        client_id: body.client_id ?? tenant.clientId.trim(),
        ...body,
      };
      return wrap(sent, await call('/e/authorize', sent));
    },

    /**
     * Redeem the code at the tenant's real token endpoint.
     *
     * No code_verifier unless a challenge actually went out. Live mode omits PKCE because the
     * initiate schema rejects it, and sending a verifier for a challenge that was never made is a
     * request no client would ever produce.
     */
    tokenSeed() {
      return {
        grant_type: 'authorization_code',
        client_id: tenant.clientId.trim(),
        code: authorizationCode ?? '<authorization_code>',
        ...(sentCodeChallenge ? { code_verifier: '<code_verifier>' } : {}),
      };
    },

    async exchange(body) {
      const sent = body ?? this.tokenSeed();
      return wrap(sent, await call('/oauth/token', sent), '/oauth/token');
    },

    /** Whether a refresh token came back, i.e. whether the MRRT step can be offered at all. */
    hasRefreshToken() {
      return !!refreshToken;
    },

    /**
     * MRRT: trade the refresh token for an access token aimed at another API. The audience is the
     * My Account API's, `https://{domain}/me/` — the tenant's own domain, which must match the one
     * the token was issued for. It is a default, not a rule: the payload is editable.
     */
    refreshSeed() {
      return {
        grant_type: 'refresh_token',
        client_id: tenant.clientId.trim(),
        refresh_token: refreshToken ?? '<refresh_token>',
        audience: `https://${hostOf(tenant.domain)}/me/`,
        scope: 'read:me:profile update:me:profile read:me:authentication_methods read:me:factors',
      };
    },

    async refresh(body) {
      const sent = body ?? this.refreshSeed();
      return wrap(sent, await call('/oauth/token', sent), '/oauth/token');
    },

    /** The access token the last refresh (or the code exchange) produced. */
    profileSeed() {
      return { access_token: accessToken ?? '<access_token>' };
    },

    /**
     * GET /me/v1/profile. `body` is { access_token, fields?, include_fields? }: the token travels
     * as an Authorization header, never in the URL, and the rest become the query string.
     */
    async getProfile(body) {
      const { access_token: token, fields, include_fields: include } = body ?? this.profileSeed();
      const q = new URLSearchParams();
      if (fields) q.set('fields', fields);
      if (include !== undefined && include !== '') q.set('include_fields', String(include));
      const path = `/me/v1/profile${q.size ? `?${q}` : ''}`;
      return wrap(
        { access_token: token, ...(fields ? { fields } : {}) },
        await call(path, undefined, { method: 'GET', authorization: `Bearer ${token}` }),
        path,
        'GET'
      );
    },

    /** PATCH /me/v1/profile. Everything but `access_token` is the JSON body, as typed. */
    updateSeed() {
      return { access_token: accessToken ?? '<access_token>', family_name: 'Hazell nut' };
    },

    async updateProfile(body) {
      const { access_token: token, ...patch } = body ?? this.updateSeed();
      return wrap(
        { access_token: token, ...patch },
        await call('/me/v1/profile', patch, { method: 'PATCH', authorization: `Bearer ${token}` }),
        '/me/v1/profile',
        'PATCH'
      );
    },

    /** GET /me/v1/authentication-methods. `type` (optional) filters by factor type. */
    authMethodsSeed() {
      return { access_token: accessToken ?? '<access_token>' };
    },

    async listAuthMethods(body) {
      const { access_token: token, type } = body ?? this.authMethodsSeed();
      const path = `/me/v1/authentication-methods${type ? `?${new URLSearchParams({ type })}` : ''}`;
      return wrap(
        { access_token: token, ...(type ? { type } : {}) },
        await call(path, undefined, { method: 'GET', authorization: `Bearer ${token}` }),
        path,
        'GET'
      );
    },

    /** GET /me/v1/factors: which factor types the tenant offers this user. No query parameters. */
    factorsSeed() {
      return { access_token: accessToken ?? '<access_token>' };
    },

    async listFactors(body) {
      const { access_token: token } = body ?? this.factorsSeed();
      return wrap(
        { access_token: token },
        await call('/me/v1/factors', undefined, { method: 'GET', authorization: `Bearer ${token}` }),
        '/me/v1/factors',
        'GET'
      );
    },

    seedFor(nextEntry) {
      const cap = byId(nextEntry.action);
      const seed = {
        auth_session: authSession,
        client_id: tenant.clientId.trim(),
        action: nextEntry.action,
      };
      // Echo whatever the server itself put on the next[] entry — it is the authority here,
      // not the local capability registry.
      for (const k of ['index', 'delivery_method']) {
        if (nextEntry[k] !== undefined && !Array.isArray(nextEntry[k])) seed[k] = nextEntry[k];
      }
      // The descriptor offers `delivery_methods`; the request must name one of them.
      if (Array.isArray(nextEntry.delivery_methods) && nextEntry.delivery_methods.length) {
        seed.delivery_method ??= nextEntry.delivery_methods[0];
      }
      /* verify:otp's `type` says what kind of code this is, and the server names it on the entry as
         `channel`. The registry's example ("oob") was recorded from an email code, so for a TOTP
         entry it is simply wrong; the entry is the authority, as with index and delivery_method. */
      if (nextEntry.action === 'action:verify:otp:v1' && nextEntry.channel === 'totp') {
        seed.type = 'totp';
      }
      for (const f of cap?.request || []) {
        if (seed[f.name] !== undefined) continue;
        if (f.name === 'index') continue;
        seed[f.name] = f.secret ? '' : f.example ?? '';
      }
      return seed;
    },

    inspect() {
      return authSession
        ? {
            source: `Live · ${tenant.domain}`,
            auth_session: authSession,
            note: 'A real encrypted, rotating session token. Opaque by design.',
          }
        : null;
    },

    reset() {
      authSession = null;
      spent.clear();
      refreshToken = null;
      accessToken = null;
    },
  };
}
