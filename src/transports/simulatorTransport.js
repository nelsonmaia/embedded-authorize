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
import { freshState, initiate, submit, sessionPayload, negotiate, SPEC_OTP } from '../engine/engine.js';
import { CONNECTION_PRESETS, byId } from '../data/spec.js';

const SECRETS = ['password', 'recovery_code'];

/** Redacted copy for display — the request pane must not echo a password back on screen. */
function forDisplay(body) {
  const out = { ...body };
  for (const k of SECRETS) if (out[k] != null) out[k] = '••••••••';
  delete out.simulate; // internal push-rejected/expired hook, not a wire field
  return out;
}

/**
 * The suggested initiate body.
 *
 * `code_challenge` is here because the draft makes it the precondition for receiving a
 * `request_uri` on a redirect_to_web response. Delete it and the handoffs still work, but the
 * reference is withheld — which is worth being able to try.
 */
export function initiateSeed(scenario) {
  return {
    client_id: '<client_id>',
    connection: scenario.connection,
    audience: '<audience>',
    scope: 'openid profile email',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    capabilities: [...scenario.caps],
  };
}

export function simulatorTransport({ scenario }) {
  const connection = CONNECTION_PRESETS.find((c) => c.id === scenario.connection);
  let state = freshState({
    connection,
    declaredCaps: [...scenario.caps],
    mfaPolicy: scenario.mfaPolicy,
    nativeSdks: scenario.nativeSdks,
    botDetection: scenario.botDetection,
    postLogin: scenario.postLogin,
  });

  /* How far through `scenario.script` the session has walked. script[0] is the initiate call, so
     after start() this points at the first continuation. Only used to prefill; the engine never
     consults it, and stepping off the script simply stops it matching. */
  let step = 0;

  const wrap = (sent, r) => ({
    request: { method: 'POST', path: '/e/authorize', body: forDisplay(sent) },
    status: r.status,
    body: structuredClone(r.body),
    note: r.note,
    gap: r.gap,
    handoff: r.handoff,
    legOutcome: r.legOutcome,
    negotiation: r.negotiation,
  });

  return {
    kind: 'simulator',
    isLive: false,

    /** `body` is what the user typed, and is shown as sent. Note the simulator negotiates from the
     *  scenario's declared capabilities, so editing `capabilities` here is cosmetic — change the
     *  flow to change what is negotiated. */
    async start(body) {
      const sent = body ?? initiateSeed(scenario);
      // Unlike `capabilities`, PKCE is read from what was actually sent — deleting code_challenge
      // here has consequences, because the draft forbids returning a request_uri without it.
      step = 1;
      return wrap(sent, initiate(state, sent));
    },

    async send(body) {
      const { action, ...payload } = body;

      // The scenario's `simulate` hook is applied HERE rather than seeded into the request body.
      // It is not a wire field — no client ever sends it — so putting it in the request pane would
      // show a contract that does not exist. The scenario already says it is simulating an
      // abandoned browser leg; the request stays what a real client would send.
      const scripted = scenario.script?.[step];
      const simulate = scripted?.action === action ? scripted.payload?.simulate : undefined;

      const sent = { auth_session: state.authSession, ...body };
      const res = wrap(sent, submit(state, action, simulate ? { ...payload, simulate } : payload));
      step += 1;
      return res;
    },

    /**
     * Prefill the next request.
     *
     * The scenario's own `script` wins, because that is what makes a scenario mean anything: the
     * decoy flow needs an address that does NOT exist, the lockout flow needs codes that are
     * WRONG, and "MFA required, nothing enrolled" needs the user who has nothing enrolled. Seeding
     * from the capability registry instead handed every one of them the happy-path value, so seven
     * scenarios quietly demonstrated the opposite of their label — a lockout that logged you in, a
     * decoy that resolved to a real user.
     *
     * Registry examples remain the fallback, for any action the script does not reach or once the
     * user has stepped off it. `otp` falls back to the code this simulator accepts rather than the
     * registry's 032252, which is a real code from the verified tenant walk — right for live mode
     * and the contract view, guaranteed to fail here.
     */
    seedFor(nextEntry) {
      const cap = byId(nextEntry.action);
      const seed = { auth_session: state.authSession, action: nextEntry.action };

      for (const f of cap?.request || []) {
        // `index` is carried by the next[] entry itself; echo it rather than inventing one.
        if (f.name === 'index') {
          if (nextEntry.index !== undefined) seed.index = nextEntry.index;
          continue;
        }
        seed[f.name] = f.name === 'otp' ? SPEC_OTP : f.example ?? '';
      }

      // Only when the script is still in step with what the user is actually doing. Pick a
      // different action from `next[]` and the script no longer describes this call.
      const scripted = scenario.script?.[step];
      if (scripted?.action === nextEntry.action) {
        // `simulate` is deliberately not seeded — see send(). Everything else the script names is.
        const { simulate, ...wireFields } = scripted.payload ?? {};
        Object.assign(seed, wireFields);
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
        botDetection: scenario.botDetection,
        postLogin: scenario.postLogin,
      });
      step = 0;
    },
  };
}
