/**
 * One flat catalogue of everything you can drive, with labels a person can scan.
 *
 * Signup flows come from the extracted call sequences; login flows come from the simulator's
 * scenarios. The UI does not care which is which beyond picking a transport, so both are flattened
 * into the same shape here: a flow, optionally with variants.
 *
 * Labels are derived from the connection configuration, not from document structure — "Email +
 * phone · optional password" says what the flow *is*, which is what you pick on.
 */
import { SIGNUP_SCENARIOS } from './signupPrd.js';
import { CONNECTION_PRESETS, ENTERPRISE_STRATEGIES, LOCAL_STRATEGIES } from './spec.js';
import { SCENARIOS as LOGIN_SCENARIOS } from './loginScenarios.js';

/** "Email + phone · optional password" — the connection, in words. */
function configLabel(derived) {
  const { email, phone, password } = derived;
  let ids;
  if (phone === 'disabled') ids = 'Email';
  else if (email === 'disabled') ids = 'Phone';
  else if (email === 'required' && phone === 'required') ids = 'Email + phone';
  else if (phone === 'optional') ids = 'Email, phone optional';
  else if (email === 'optional') ids = 'Phone, email optional';
  else ids = 'Email + phone';

  const pw =
    password === 'none' ? 'no password' : password === 'optional' ? 'optional password' : 'required password';
  return `${ids} · ${pw}`;
}

/** Variant titles from the source read fine already; just tidy the ones that don't. */
function variantLabel(hp, total) {
  if (total === 1) return null;
  return (hp.title || `Variant ${hp.number}`)
    .replace(/\(most complete\)/, '— fullest path')
    .replace(/^required only.*/i, 'Minimum — skip everything optional');
}

/**
 * The chips, arranged around the questions a developer reading this contract actually asks:
 *
 *   What am I looking at?      Sign up / Sign in
 *   Do I need a WebView?       Redirect to Web
 *   What can go wrong?         Errors
 *
 * The earlier set answered none of the last three. It had a chip for a single flow, an umbrella
 * sitting beside its own children, and a "Sign in" bucket that lost any flow tagged as an error —
 * so a sign-in error was in neither. Narrow feature tags moved to the second row, where one of ten
 * is a real narrowing rather than a bookmark.
 */
export const FLOW_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'signup', label: 'Sign up' },
  { id: 'login', label: 'Sign in' },
  { id: 'browser', label: 'Redirect to Web' },
  { id: 'errors', label: 'Errors' },
];

export const matchesFilter = (flow, filterId) => {
  switch (filterId) {
    case 'all': return true;
    case 'signup': return flow.journey === 'Sign up';
    case 'login': return flow.journey === 'Sign in';
    case 'browser': return flow.browser === true;
    case 'errors': return flow.errorKind !== null;
    default: return false;
  }
};

/** Heading order in the dropdown. */
export const FLOW_GROUPS = ['Sign up', 'Sign in'];

/* ── second row ───────────────────────────────────────────────────────────
   One axis per chip, chosen because it answers the next question that chip
   raises — not a single global axis applied everywhere regardless of fit. */

const passwordFacet = (d) =>
  d.password === 'none' ? 'No password' : d.password === 'optional' ? 'Optional password' : 'Required password';

/** A simulated signup enrols a password only if the connection enables one. */
const signupPasswordFacet = (connectionId) => {
  const preset = CONNECTION_PRESETS.find((c) => c.id === connectionId);
  return preset?.authMethods?.includes('password') ? 'Optional password' : 'No password';
};

/**
 * Recoverable or terminal — the only thing a client really needs to know about an error, because
 * it decides between retrying and restarting. Derived from the scenario's declared outcome rather
 * than hand-tagged, so it cannot drift from what the flow actually does.
 */
const errorKindOf = (scenario) => {
  if (!scenario?.expect) return null;
  if (['denied', 'invalid_session'].includes(scenario.expect)) return 'Terminal';
  if (['refused', 'server_error'].includes(scenario.expect)) return 'Recoverable';
  return scenario.demonstrates ? 'Recoverable' : null;
};

/**
 * What a sign-in flow is ABOUT — the part of the protocol it exercises.
 *
 * Thirty flows is the longest list in the picker and the one most in need of narrowing, so it gets
 * an axis after all. It is ordered rather than additive: a flow that pauses for a form is filed
 * under Post-login even though it also used a password, because the reason to open it is the form.
 */
const coversOf = (s) => {
  const has = (c) => (s.categories ?? []).includes(c);
  const cap = (c) => (s.caps ?? []).some((x) => x.includes(c));
  if (has('bot')) return 'Bot detection';
  if (has('federation') || cap('authn:ns:')) return 'Federation';
  if (has('forms') || has('actions')) return 'Post-login';
  if (cap('passkey')) return 'Passkey';
  if (s.mfaPolicy === 'Always') return 'MFA';
  // Flows whose subject is the envelope itself — the session, the allow-list, the request body —
  // rather than any particular factor.
  if (['session-replay', 'out-of-order', 'missing-field', 'upstream-outage', 'password-only'].includes(s.id)) {
    return 'Protocol';
  }
  if (cap('verify:password')) return 'Password';
  if (cap('verify:otp')) return 'OTP';
  return 'Other';
};

/** Which web leg a browser-opening flow demonstrates. */
const browserFeatureOf = (cats) =>
  cats.includes('actions') ? 'Actions redirect'
    : cats.includes('forms') ? 'Forms'
    : cats.includes('bot') ? 'Bot detection'
    : cats.includes('federation') ? 'Federation'
    : 'Other';

const FACET_BY_FILTER = {
  signup: { label: 'Password', of: (f) => f.passwordFacet },
  login: {
    label: 'Covers',
    of: (f) => f.covers,
    order: ['OTP', 'Password', 'MFA', 'Passkey', 'Federation', 'Bot detection', 'Post-login', 'Protocol'],
  },
  errors: { label: 'Recovery', of: (f) => f.errorKind },
  browser: { label: 'Web leg', of: (f) => f.browserFeature },
};

/**
 * The second row for the active chip, or null when it would not help.
 *
 * Each chip picks the axis that answers ITS follow-up: signup configurations differ by password,
 * errors split into retry-or-restart, sign-in flows by which part of the protocol they exercise.
 * "All" gets none — it spans two journeys with nothing in common to ask about, and forcing one
 * axis everywhere is how the previous version offered "Connection: Database 6" to somebody
 * reading error shapes.
 */
export const facetsFor = (filterId, flows) => {
  const def = FACET_BY_FILTER[filterId];
  if (!def) return null;

  const counts = new Map();
  for (const f of flows) {
    const v = def.of(f);
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size < 2) return null;

  const items = [...counts].map(([label, count]) => ({ label, count }));
  if (def.order) items.sort((a, b) => def.order.indexOf(a.label) - def.order.indexOf(b.label));
  return { label: def.label, of: def.of, items };
};

export const SIGNUP_FLOWS = SIGNUP_SCENARIOS.map((s) => ({
  id: `signup:${s.id}`,
  kind: 'signup',
  journey: 'Sign up',
  group: 'Sign up',
  browser: false,
  errorKind: null,
  passwordFacet: passwordFacet(s.config.derived),
  label: configLabel(s.config.derived),
  detail: s.config.derived,
  scenario: s,
  variants: s.happyPaths.map((hp) => ({
    id: hp.id,
    label: variantLabel(hp, s.happyPaths.length),
    calls: hp.exchanges.length,
    happyPath: hp,
  })),
}));

export const LOGIN_FLOWS = LOGIN_SCENARIOS.map((s) => {
  const cats = s.categories ?? [];
  const isSignup = cats.includes('signup');
  return {
  id: `login:${s.id}`,
  kind: 'login',
  // What the flow IS, not which transport drives it: a simulated signup belongs under Sign up
  // beside the recorded ones. Every other scenario is a sign-in journey, INCLUDING the ones whose
  // point is an error — those used to fall out of Sign in and land nowhere.
  journey: isSignup ? 'Sign up' : 'Sign in',
  group: isSignup ? 'Sign up' : 'Sign in',
  categories: cats,
  // Declared on the scenario, verified by driving it — a browser leg is the one thing the picker
  // claims that the engine can check, so `tests/webflows.test.js` asserts this against whether any
  // response actually came back redirect_to_web.
  browser: s.browser === true,
  errorKind: errorKindOf(s),
  browserFeature: browserFeatureOf(cats),
  covers: isSignup ? null : coversOf(s),
  passwordFacet: isSignup ? signupPasswordFacet(s.connection) : null,
  label: s.label,
  detail: null,
  scenario: s,
  variants: [],
  };
});

export const ALL_FLOWS = [...SIGNUP_FLOWS, ...LOGIN_FLOWS];

export const flowById = (id) => ALL_FLOWS.find((f) => f.id === id);

export const DEFAULT_FLOW_ID = SIGNUP_FLOWS[0].id;
