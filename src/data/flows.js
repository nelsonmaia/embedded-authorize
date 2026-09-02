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

export const SIGNUP_FLOWS = SIGNUP_SCENARIOS.map((s) => ({
  id: `signup:${s.id}`,
  kind: 'signup',
  group: 'Sign up',
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

export const LOGIN_FLOWS = LOGIN_SCENARIOS.map((s) => ({
  id: `login:${s.id}`,
  kind: 'login',
  group: 'Sign in',
  label: s.label,
  detail: null,
  scenario: s,
  variants: [],
}));

export const ALL_FLOWS = [...SIGNUP_FLOWS, ...LOGIN_FLOWS];

export const flowById = (id) => ALL_FLOWS.find((f) => f.id === id);

export const DEFAULT_FLOW_ID = SIGNUP_FLOWS[0].id;
