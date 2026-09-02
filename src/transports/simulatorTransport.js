/**
 * simulatorTransport — the login state machine, actually running.
 *
 * Unlike the canned transport, nothing here is recorded: engine.js computes each response from
 * session state, so a wrong OTP really fails, the attempt cap really trips, and an action missing
 * from `next[]` really gets refused. This is the half of spec mode where editing a payload has
 * consequences.
 *
 * engine.js mutates its state object in place — that is how the real orchestrator works, one
 * session advancing through a pipeline. This adapter owns that object and hands out immutable
 * snapshots, so React never has to notice a mutated reference. That retires the manual `version`
 * counter the old hook needed.
 */
import { freshState, initiate, submit, sessionPayload, negotiate } from '../engine/engine.js';
import { CONNECTION_PRESETS, byId } from '../data/spec.js';

const SECRETS = ['password', 'recovery_code'];

/** Redacted copy for display — the request pane must not echo a password back on screen. */
function forDisplay(body) {
  const out = { ...body };
  for (const k of SECRETS) if (out[k] != null) out[k] = '••••••••';
  delete out.simulate; // internal push-rejected/expired hook, not a wire field
  return out;
}

export function simulatorTransport({ scenario }) {
  const connection = CONNECTION_PRESETS.find((c) => c.id === scenario.connection);
  let state = freshState({
    connection,
    declaredCaps: [...scenario.caps],
    mfaPolicy: scenario.mfaPolicy,
    nativeSdks: scenario.nativeSdks,
  });

  const wrap = (sent, r) => ({
    request: { method: 'POST', path: '/e/authorize', body: forDisplay(sent) },
    status: r.status,
    body: structuredClone(r.body),
    note: r.note,
    gap: r.gap,
    negotiation: r.negotiation,
  });

  return {
    kind: 'simulator',
    isLive: false,

    /** `body` is what the user typed, and is shown as sent. Note the simulator negotiates from the
     *  scenario's declared capabilities, so editing `capabilities` here is cosmetic — change the
     *  flow to change what is negotiated. */
    async start(body) {
      const sent = body ?? {
        client_id: '<client_id>',
        connection: scenario.connection,
        audience: '<audience>',
        scope: 'openid profile email',
        capabilities: [...scenario.caps],
      };
      return wrap(sent, initiate(state));
    },

    async send(body) {
      const { action, ...payload } = body;
      const sent = { auth_session: state.authSession, ...body };
      return wrap(sent, submit(state, action, payload));
    },

    /** Prefill from the capability registry's declared example values. */
    seedFor(nextEntry) {
      const cap = byId(nextEntry.action);
      const seed = { auth_session: state.authSession, action: nextEntry.action };
      for (const f of cap?.request || []) {
        // `index` is carried by the next[] entry itself; echo it rather than inventing one.
        if (f.name === 'index') {
          if (nextEntry.index !== undefined) seed.index = nextEntry.index;
          continue;
        }
        seed[f.name] = f.example ?? '';
      }
      return seed;
    },

    inspect() {
      if (!state || state.phase === 'uninitialised') return null;
      return {
        source: `Simulated from the RFDs · ${scenario.label}`,
        auth_session: state.authSession,
        rotations: state.rotations,
        payload: sessionPayload(state),
        negotiation: negotiate(state),
      };
    },

    reset() {
      state = freshState({
        connection,
        declaredCaps: [...scenario.caps],
        mfaPolicy: scenario.mfaPolicy,
        nativeSdks: scenario.nativeSdks,
      });
    },
  };
}
