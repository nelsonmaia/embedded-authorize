/**
 * The transport contract. Three implementations, one interface, so the UI never branches on mode.
 *
 *   cannedTransport    — replays the Signup PRD's documented request/response pairs
 *   simulatorTransport — runs engine.js, which genuinely computes login responses
 *   liveTransport      — real HTTP against a tenant, via the Vite dev middleware
 *
 * Spec and live are independent by design: nothing falls back from one to the other. A live call
 * that fails reports that it failed; it does not quietly answer from the spec.
 *
 * Every method is async — including the two synchronous ones, which resolve immediately — so the
 * UI has exactly one code path. The old useEngine.js duplicated a sync branch and an async branch
 * in three separate functions; this is what removes that.
 *
 * @typedef {{ method: 'POST', path: string, body: Object }} Request
 *
 * @typedef {Object} Result
 * @property {Request}  request           what was actually sent (after any user edits)
 * @property {number}   status
 * @property {Object}   body
 * @property {boolean} [statusDerived]    canned: the PRD carries no status line
 * @property {number}  [durationMs]       live only
 * @property {string}  [label]            human step name
 * @property {string}  [note]             prose explaining why `next` changed
 * @property {string}  [gap]              a KNOWN_GAPS title, when this call demonstrates one
 * @property {Object}  [negotiation]      simulator only: { offered, withheld }
 * @property {boolean} [undocumented]     canned only: the PRD has no answer for this call
 * @property {Request} [expected]         canned only: the documented request, for diffing
 * @property {string}  [error]            transport-level failure (live: unreachable, etc.)
 *
 * @typedef {Object} Transport
 * @property {'canned'|'simulator'|'live'} kind
 * @property {boolean}  isLive
 * @property {() => Promise<Result>}                   start
 * @property {(body: Object) => Promise<Result>}       send      body is authoritative — as edited
 * @property {(nextEntry: Object) => Object}           seedFor   prefill for the request editor
 * @property {() => Object|null}                       inspect   session view for the side panel
 * @property {() => void}                              reset
 */
export const TRANSPORT_KINDS = ['canned', 'simulator', 'live'];
