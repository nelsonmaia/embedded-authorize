/**
 * Selectors over the generated PRD data.
 *
 * signupPrd.generated.json is written by scripts/extract-signup-prd.mjs and must not be hand
 * edited — re-run `npm run extract` after re-fetching the Confluence page. Everything here is a
 * lookup; all counting and shape-derivation already happened in the script, where it is asserted.
 */
// The import attribute is required by Node (the test suite imports this directly); Vite honours it too.
import data from './signupPrd.generated.json' with { type: 'json' };

export const PRD_META = data.meta;
export const MILESTONES = data.milestones;
export const OPEN_QUESTIONS = data.openQuestions;
export const SIGNUP_SCENARIOS = data.scenarios;
export const NEXT_SHAPES = data.derived.nextShapes;
export const ACTION_CATALOG = data.derived.actionCatalog;

export const scenarioById = (id) => SIGNUP_SCENARIOS.find((s) => s.id === id);

export const happyPathById = (id) => {
  for (const s of SIGNUP_SCENARIOS) {
    const hp = s.happyPaths.find((h) => h.id === id);
    if (hp) return { scenario: s, happyPath: hp };
  }
  return null;
};

/** Milestones in delivery order, each with its scenarios resolved. M5 has no scenarios yet. */
export const milestoneTree = () =>
  MILESTONES.map((m) => ({
    ...m,
    scenarios: m.scenarioNumbers
      .map((n) => SIGNUP_SCENARIOS.find((s) => s.number === n))
      .filter(Boolean),
  }));

/** One-line summary of a connection config, for list rows. */
export const configSummary = (scenario) => {
  const d = scenario.config.derived;
  const bits = [];
  if (d.email !== 'disabled') bits.push(`email ${d.email}`);
  if (d.phone !== 'disabled') bits.push(`phone ${d.phone}`);
  bits.push(d.password === 'none' ? 'no password' : `password ${d.password}`);
  return bits.join(' · ');
};
