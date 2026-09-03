/**
 * Per-browser Jira sessions.
 *
 * The first version of this held one access token in module state. That is indistinguishable from
 * correct on a dev server with one user, and a real security bug anywhere else: the second person
 * to open the console would inherit the first person's token and file tickets as them. Rather than
 * refuse to run in a deployment, bind the token to the browser that consented.
 *
 * A session id is a bearer credential for someone's Jira account, so it is treated as one:
 *
 *   httpOnly            page scripts cannot read it, so an XSS cannot exfiltrate it
 *   SameSite=Lax        needed, not merely tolerated — the OAuth callback is a top-level
 *                       cross-site navigation back from auth.atlassian.com, and Strict would
 *                       withhold the cookie exactly there, breaking the flow it protects
 *   Secure over HTTPS   set from the forwarded scheme, so a deployment gets it and localhost,
 *                       which has no HTTPS, still works
 *   256 bits            not guessable
 *
 * Tokens live here in memory and are never written to disk. A restart signs everyone out, which
 * costs a click and removes any question of a credential outliving the process.
 *
 * Deliberately standalone: this file must not import from src/.
 */

import { randomBytes } from 'node:crypto';

export const COOKIE = 'ea_jira';

/** Idle timeout. Long enough not to interrupt an afternoon, short enough to bound exposure. */
const IDLE_MS = 12 * 60 * 60 * 1000;
/** A ceiling so a busy deployment cannot grow the map without bound. */
const MAX_SESSIONS = 500;

const sessions = new Map();

const newId = () => randomBytes(32).toString('base64url');

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** https when the request arrived over TLS, including behind a proxy that terminated it. */
export const isSecure = (req) =>
  String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ||
  !!req.socket?.encrypted;

function evict() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastSeen > IDLE_MS) sessions.delete(id);

  // Still over the ceiling: drop the least recently used until it fits.
  if (sessions.size > MAX_SESSIONS) {
    const order = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [id] of order.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
  }
}

/**
 * The session for this request, creating one if needed.
 *
 * Always returns a session, so the OAuth leg has somewhere to record its PKCE verifier before
 * anyone is authenticated. `created` tells the caller whether a cookie needs setting.
 */
export function sessionFor(req, res) {
  evict();

  const existing = parseCookies(req.headers.cookie)[COOKIE];
  const found = existing && sessions.get(existing);
  if (found) {
    found.lastSeen = Date.now();
    return { id: existing, session: found, created: false };
  }

  const id = newId();
  const session = { tokens: null, user: null, mcp: null, toolSchemas: null, pending: new Map(), lastSeen: Date.now() };
  sessions.set(id, session);

  if (res) {
    const attrs = [
      `${COOKIE}=${id}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(IDLE_MS / 1000)}`,
      isSecure(req) ? 'Secure' : null,
    ].filter(Boolean);
    res.setHeader('set-cookie', attrs.join('; '));
  }
  return { id, session, created: true };
}

/** Forget a session's credentials without invalidating the browser's cookie. */
export function signOut(session) {
  session.tokens = null;
  session.user = null;
  session.mcp = null;
  session.toolSchemas = null;
  session.pending.clear();
}

export const count = () => sessions.size;

/** Test seam: sessions are process state, and one test must not leak into the next. */
export const reset = () => sessions.clear();
