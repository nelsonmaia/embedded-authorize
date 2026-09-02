/**
 * liveTransport — real HTTP against a real tenant.
 *
 * Goes through `POST /__tenant`, the Vite dev middleware, for the same reason Postman works when
 * a browser doesn't: the request is made server-side, so `POST /e/authorize`'s missing CORS
 * headers are irrelevant. See scripts/vite-plugin-tenant-proxy.js.
 *
 * This transport never consults the spec. If a call fails, it reports the failure — it does not
 * substitute a documented response, because then you would not be testing your tenant.
 */
import { byId } from '../data/spec.js';

const SECRETS = ['password', 'recovery_code'];

function forDisplay(body) {
  const out = { ...body };
  for (const k of SECRETS) if (out[k] != null) out[k] = '••••••••';
  return out;
}

export function liveTransport({ tenant, capabilities }) {
  let authSession = null;

  async function call(path, body) {
    const res = await fetch('/__tenant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: tenant.domain.trim(), path, method: 'POST', body }),
    });
    return res.json();
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
    if (env.body?.auth_session) authSession = env.body.auth_session;
    return {
      request: { method: 'POST', path, body: forDisplay(sent) },
      status: env.status,
      body: env.body,
      durationMs: env.durationMs,
      gap:
        env.status >= 500
          ? 'Out-of-order action returns 500, not invalid_request'
          : undefined,
      note:
        env.status >= 500
          ? 'A 5xx here usually means the action was not in the previous `next[]`. The spec calls for invalid_request; the tenant returns 500. That is a known gap.'
          : undefined,
    };
  };

  return {
    kind: 'live',
    isLive: true,

    /** `body` is what the user typed and is sent verbatim — this is a real request to their tenant,
     *  so nothing here second-guesses it. */
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
    },
  };
}
