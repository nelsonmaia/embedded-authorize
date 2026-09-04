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

const SECRETS = ['password', 'recovery_code'];

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

  async function call(path, body) {
    let res;
    try {
      res = await fetch(TENANT(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: tenant.domain.trim(), path, method: 'POST', body }),
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

  const wrap = (sent, env, path = '/e/authorize') => {
    if (!env.ok) {
      return {
        request: { method: 'POST', path, body: forDisplay(sent) },
        status: 0,
        body: {},
        error: `${env.error}${env.detail ? ` — ${env.detail}` : ''}`,
      };
    }
    const replayed = !!sent.auth_session && spent.has(sent.auth_session);
    if (sent.auth_session && wasAccepted(env.status, env.body)) spent.add(sent.auth_session);
    if (env.body?.auth_session) authSession = env.body.auth_session;

    const exchange = {
      context: { sessionAlreadyUsed: replayed, declared },
      // The UNREDACTED body is what the checker sees: it needs to know whether a code_challenge
      // was sent, and redaction only exists so the screen does not echo a password back.
      request: { method: 'POST', path, body: sent },
      status: env.status,
      body: env.body,
    };

    return {
      request: { method: 'POST', path, body: forDisplay(sent) },
      status: env.status,
      body: env.body,
      durationMs: env.durationMs,
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
      return wrap(sent, await call('/e/authorize', sent));
    },

    async send(body) {
      // auth_session is threaded from the live response unless the user pinned their own.
      const sent = { auth_session: body.auth_session ?? authSession, ...body };
      return wrap(sent, await call('/e/authorize', sent));
    },

    async exchange(code) {
      const sent = {
        grant_type: 'authorization_code',
        code,
        client_id: tenant.clientId.trim(),
      };
      return wrap(sent, await call('/oauth/token', sent), '/oauth/token');
    },

    seedFor(nextEntry) {
      const cap = byId(nextEntry.action);
      const seed = { auth_session: authSession, action: nextEntry.action };
      // Echo whatever the server itself put on the next[] entry — it is the authority here,
      // not the local capability registry.
      for (const k of ['index', 'delivery_method']) {
        if (nextEntry[k] !== undefined && !Array.isArray(nextEntry[k])) seed[k] = nextEntry[k];
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
    },
  };
}
