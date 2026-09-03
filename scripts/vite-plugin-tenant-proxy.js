/**
 * vite-plugin-tenant-proxy.js — live-tenant calls from the dev server.
 *
 * The forwarding itself lives in ./tenant-proxy/forward.js, shared with the deployed server so the
 * two cannot drift. This file is only the Vite binding.
 *
 * Not `server.proxy`: that resolves its `target` when the config loads, and the tenant domain is
 * typed by the user at runtime. A middleware doing its own `fetch` is simpler and easier to lock
 * down.
 *
 * `apply: 'serve'` — this binding is dev only. The deployed server mounts the same handler itself,
 * under a strict allowlist, which is a decision rather than an accident.
 *
 * Contract:  POST /__tenant   { domain, path, method, body, contentType? }
 *            → { ok: true, status, headers, body, durationMs } | { ok: false, error, detail }
 */

import { forward, readBody, send } from './tenant-proxy/forward.js';

/* Re-exported so the proxy tests keep driving the real implementation through its documented
   entry point rather than reaching around it. */
export { forward };

export function tenantProxy() {
  return {
    name: 'e-authorize-tenant-proxy',
    apply: 'serve', // dev only — absent from any build output

    configureServer(server) {
      const log = (m) => server.config.logger.info(m);
      const warn = (m) => server.config.logger.warn(m);

      server.middlewares.use('/__tenant', async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          return res.end();
        }
        if (req.method !== 'POST') return next();

        let envelope;
        try {
          envelope = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return send(res, 400, { ok: false, error: 'invalid_body', detail: 'Body is not JSON.' });
        }
        return forward(envelope, res, { log, warn });
      });
    },
  };
}
