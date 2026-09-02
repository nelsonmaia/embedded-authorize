/**
 * cannedTransport — replays one happy path from the Signup PRD.
 *
 * This is the spec, verbatim. Every response here was extracted from Confluence page 1068894784
 * and round-trip asserted, so what you see on screen is what the document says, not an
 * approximation of it.
 *
 * Payloads stay editable, and edits are sent. Two things can then happen:
 *
 *   - You changed a *value* (a different email, a different OTP). The documented response still
 *     applies, so it is returned — with `identifier` re-masked from your value, so the response
 *     stays coherent with what you actually sent.
 *   - You changed the *action*, to something this path does not document next. Rather than invent
 *     a response, it says so. Fabricating spec would make this tool worse than the document.
 */
import { maskIdentifier } from '../data/spec.js';

/**
 * Re-mask `next[].identifier` when — and only when — the user changed the identifier they sent.
 *
 * Unedited payloads must return the PRD's response byte-for-byte, so the screen can be diffed
 * against Confluence. That matters because the masking conventions genuinely differ: the signup
 * PRD writes `usxx@exxxxxx.com`, the D2 RFD writes `j***e@e****e.com`, and a real tenant returns
 * `haze******@okta****`. Applying our own masking to an unedited call would silently contradict
 * the document. Once you edit the value the documented mask is stale anyway, so we substitute
 * ours and say so.
 */
function remask(body, sentBody, documentedBody) {
  if (!Array.isArray(body.next)) return body;
  const typed = sentBody.email ?? sentBody.phone;
  const documented = documentedBody?.email ?? documentedBody?.phone;
  if (typed == null || typed === documented) return body;

  const clone = structuredClone(body);
  for (const n of clone.next) {
    if (typeof n.identifier === 'string') n.identifier = maskIdentifier(typed);
  }
  return clone;
}

export function cannedTransport({ scenario, happyPath }) {
  let cursor = 0;

  const at = (i) => happyPath.exchanges[i] ?? null;

  const resultFrom = (ex, sentBody) => ({
    request: { method: 'POST', path: '/e/authorize', body: sentBody },
    status: ex.response.status,
    statusDerived: true,
    body: remask(ex.response.body, sentBody, ex.request.body),
    label: ex.label,
    note: ex.note,
    expected: ex.request,
  });

  return {
    kind: 'canned',
    isLive: false,

    /** `body` is what the user typed. It is authoritative — the documented body is only a seed. */
    async start(body) {
      cursor = 0;
      const ex = at(0);
      const r = resultFrom(ex, body ?? structuredClone(ex.request.body));
      cursor = 1;
      return r;
    },

    async send(body) {
      const ex = at(cursor);
      if (!ex) {
        return {
          request: { method: 'POST', path: '/e/authorize', body },
          status: 0,
          undocumented: true,
          body: {},
          error: `This happy path ends after ${happyPath.exchanges.length} calls — the PRD documents nothing further.`,
        };
      }
      if (body.action !== ex.request.body.action) {
        return {
          request: { method: 'POST', path: '/e/authorize', body },
          status: 0,
          undocumented: true,
          body: {},
          expected: ex.request,
          error:
            `Scenario ${scenario.number} / ${happyPath.label} documents "${ex.request.body.action}" ` +
            `as call ${cursor + 1}, not "${body.action}". The PRD has no response for this, so ` +
            'none is shown — pick another happy path, or explore it in the login simulator.',
        };
      }
      const r = resultFrom(ex, body);
      cursor += 1;
      return r;
    },

    /** The documented request for whichever call comes next, so the editor opens prefilled. */
    seedFor() {
      const ex = at(cursor);
      return ex ? structuredClone(ex.request.body) : {};
    },

    inspect() {
      const prev = at(cursor - 1);
      return {
        source: `PRD page 1068894784 · Scenario ${scenario.number} · ${happyPath.label}`,
        call: `${Math.min(cursor, happyPath.exchanges.length)} of ${happyPath.exchanges.length}`,
        auth_session: prev?.sessionOut ?? null,
        note: 'Sessions here are the PRD\'s placeholders (sess_1…), not real encrypted tokens.',
      };
    },

    reset() {
      cursor = 0;
    },
  };
}
