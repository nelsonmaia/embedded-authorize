/**
 * Where the server-side routes live, relative to wherever this app is mounted.
 *
 * The console is not always at a domain root. A platform may serve it under a path — ours reports
 * `/a0-b2c-core/apps/v1/embedded-authorize/` — and then a root-absolute `fetch('/__tenant')` leaves
 * the app entirely and lands on whatever is at the domain root. It fails in the same shape as
 * having no server at all, which is a miserable thing to debug twice.
 *
 * So every call is resolved against the document's own base. At a root deployment this is
 * identical to what it replaces; under a path it is the difference between working and not.
 */

/* Vite's BASE_URL, which the build may set to a relative './'. Resolved once against the document
   so callers get a plain absolute URL and cannot accidentally re-resolve a relative one. */
const BASE = new URL(
  (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || './',
  typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'
);

/** @param {string} path e.g. '/__tenant' or '__jira/issue' */
export const endpoint = (path) => new URL(String(path).replace(/^\/+/, ''), BASE).toString();

export const TENANT = () => endpoint('__tenant');
export const HEALTH = () => endpoint('__health');
export const JIRA = (sub = '') => endpoint(`__jira${sub}`);
