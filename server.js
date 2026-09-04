/**
 * server.js — the deployed console: the built app, plus the one endpoint it cannot do without.
 *
 * `POST /e/authorize` sends no CORS headers, so the browser cannot call a tenant directly. In
 * development that gap is filled by a Vite middleware; here it is filled by the same `forward()`
 * function, imported rather than reimplemented, so what you tested locally is what runs.
 *
 * /__jira is mounted here too. It is safe to because tokens are held per browser session rather
 * than in module state -- see scripts/jira-mcp/sessions.js. Nothing about it needs configuring:
 * the server registers its own OAuth client on first use and holds no secret.
 *
 * Run it with:  node server.js        (PORT, default 8080)
 *
 * Before it will forward anything, set PLAYGROUND_ALLOWED_HOSTS to the exact tenant domains this
 * deployment may reach. It runs `forward` in strict mode, which does not honour the *.auth0.com
 * convenience default — see scripts/tenant-proxy/forward.js for why that matters once the host is
 * reachable by someone other than you.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { forward, readBody, send } from './scripts/tenant-proxy/forward.js';
import { handleJira } from './scripts/jira-mcp/handler.js';

/* A .env beside the server, if there is one. Without this the variables below only work when
   exported into the shell, which is a surprising way for a documented setting to fail. */
try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch {
  /* no .env — the environment is expected to carry it */
}

const ROOT = resolve(fileURLToPath(new URL('./dist', import.meta.url)));
const PORT = Number(process.env.PORT || 8080);

/* Where this app is mounted, if it is not at a domain root. A platform may serve it under a path
   and proxy through with the prefix intact, in which case every route arrives wearing it. The
   platform we deploy to injects PUBLIC_URL for exactly this. */
const BASE_PATH = `/${(process.env.BASE_PATH || process.env.PUBLIC_URL || process.env.NEXT_PUBLIC_BASE_PATH || '').trim()}`
  .replace(/\/+/g, '/')
  .replace(/\/$/, '');

/** The API routes, matched wherever in the path they appear. */
const API_ROUTES = ['/__tenant', '/__health', '/__jira'];

/**
 * Split a request path into "which of our routes is this" and "what came after".
 *
 * Matched by position rather than by stripping a configured prefix, so the server works whether or
 * not the platform tells it where it is mounted. Getting this wrong is invisible: an unmatched
 * /__tenant falls through to the SPA and returns index.html, which the console then reports as
 * "no server", having asked a server that was right there.
 */
function apiRoute(pathname) {
  for (const name of API_ROUTES) {
    const at = pathname.indexOf(name);
    if (at === -1) continue;
    const rest = pathname.slice(at + name.length);
    // Only an exact match or a subpath — never a route that merely starts with the same letters.
    if (rest === '' || rest.startsWith('/')) return { name, rest: rest || '/' };
  }
  return null;
}

/** Strip the mount prefix from a static request, so /<base>/assets/x.js finds dist/assets/x.js. */
function localFilePath(pathname) {
  if (BASE_PATH.length > 1 && pathname.startsWith(BASE_PATH)) {
    return pathname.slice(BASE_PATH.length) || '/';
  }
  // Not configured: Vite fingerprints everything under /assets/, so that segment is a reliable
  // anchor when a prefix is present but unannounced.
  const assets = pathname.indexOf('/assets/');
  return assets > 0 ? pathname.slice(assets) : pathname;
}

/* Rate limit. The dev proxy needs none: it is bound to localhost and there is one of you. A
   deployed one is a public door to a set of tenants, and a flat cap per address is the difference
   between a testing console and something an attacker can drive. */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.TENANT_RATE_LIMIT || 60);
const hits = new Map();

function overLimit(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  // Bounded cleanup, so a long-lived process does not accumulate an entry per address seen.
  if (hits.size > 5000) {
    for (const [key, times] of hits) if (!times.some((t) => now - t < WINDOW_MS)) hits.delete(key);
  }
  return recent.length > MAX_PER_WINDOW;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(req, res, pathname) {
  // Resolve first, then prove the result is still inside dist: normalize alone does not stop
  // an encoded traversal, and a symlink out of the tree would not be caught by string checks.
  const requested = resolve(join(ROOT, normalize(decodeURIComponent(pathname))));
  const inside = requested === ROOT || requested.startsWith(ROOT + sep);

  let file = inside ? requested : null;
  let info = file && (await stat(file).catch(() => null));

  // A directory, a miss, or anything outside the tree falls back to the SPA entry point, which is
  // what makes a deep link work on reload.
  if (!info || info.isDirectory()) {
    file = join(ROOT, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) return send(res, 500, { ok: false, error: 'not_built', detail: 'Run `npm run build` first.' });
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', type);
  res.setHeader('content-length', info.size);
  // Vite fingerprints asset filenames, so they are immutable; index.html must never be.
  res.setHeader(
    'cache-control',
    file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable'
  );
  // The console renders tenant responses as text, never as markup, but a deployed page should not
  // rely on that alone.
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');

  if (req.method === 'HEAD') return res.end();
  return createReadStream(file).pipe(res);
}

/** Exported so the tests can drive the real server over a real socket, not a mock of it. */
export const createConsoleServer = () =>
  createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const api = apiRoute(pathname);

  try {
    if (api?.name === '/__tenant') {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        return res.end();
      }
      // Same shape as the dev middleware, so a wrong method reads the same way in both.
      if (req.method !== 'POST') {
        return send(res, 405, { ok: false, error: 'method_not_allowed', detail: 'POST only.' });
      }

      const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
        || req.socket.remoteAddress
        || 'unknown';
      if (overLimit(ip)) {
        return send(res, 429, {
          ok: false,
          error: 'rate_limited',
          detail: `More than ${MAX_PER_WINDOW} tenant calls in a minute from one address.`,
        });
      }

      let envelope;
      try {
        envelope = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return send(res, 400, { ok: false, error: 'invalid_body', detail: 'Body is not JSON.' });
      }

      return forward(envelope, res, {
        strict: true, // exact hosts only — see the header
        // eslint-disable-next-line no-console
        log: (m) => console.log(m),
        // eslint-disable-next-line no-console
        warn: (m) => console.warn(m),
      });
    }

    /* Is this server actually answering? The question sounds trivial and is not: a static host in
       front of the build answers GET / with the app and POST /__tenant with 405, which reads as an
       HTTP-method problem rather than a missing backend. Nothing static can produce this reply, so
       one request settles it — for the console, and for a human with curl. */
    if (api?.name === '/__health') {
      return send(res, 200, {
        ok: true,
        server: 'embedded-authorize',
        routes: ['/__tenant', '/__jira', '/__health'],
        tenantsAllowed: (process.env.PLAYGROUND_ALLOWED_HOSTS || '')
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean).length,
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
      });
    }

    if (api?.name === '/__jira') {
      // The handler expects a URL relative to its mount point, as the Vite middleware gives it.
      req.url = api.rest + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
      if (await handleJira(req, res)) return;
      return send(res, 404, { ok: false, error: 'unknown_route' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { ok: false, error: 'method_not_allowed' });
    }
    return await serveStatic(req, res, localFilePath(pathname));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`  server  ${req.method} ${pathname} → ${err.message}`);
    if (!res.headersSent) send(res, 500, { ok: false, error: 'server_error' });
  }
  });

/* Only listen when run as a program. Importing this file must not open a port, or the tests would
   fight the dev server for one. */
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  createConsoleServer().listen(PORT, () => {
    const allowed = (process.env.PLAYGROUND_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
    // eslint-disable-next-line no-console
    console.log(`  console  listening on :${PORT}`);
    // eslint-disable-next-line no-console
    console.log(
      allowed.length
        ? `  tenants  ${allowed.join(', ')}`
        : '  tenants  none allowed — set PLAYGROUND_ALLOWED_HOSTS or live mode will not forward'
    );
  });
}
