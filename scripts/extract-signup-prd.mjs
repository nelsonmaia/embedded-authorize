/**
 * extract-signup-prd.mjs — turn the Signup PRD into committed data.
 *
 *   node scripts/extract-signup-prd.mjs
 *
 * Reads  src/data/sources/signup-prd-1068894784.md   (committed source of truth)
 * Writes src/data/signupPrd.generated.json           (committed, never hand-edited)
 *
 * The PRD is machine-regular: every happy path is a strictly alternating run of
 * "POST /e/authorize" fences and "Response:" fences. That regularity is not assumed — it is
 * asserted, and this script exits non-zero rather than emitting partial data. If Confluence
 * changes shape, this fails loudly instead of silently dropping scenarios.
 *
 * Two things are DERIVED and flagged as such, because the PRD does not state them:
 *   - HTTP status. Response blocks carry no status line. `authorization_code` present → 200,
 *     `error: insufficient_authorization` → 403. Every emitted response has statusDerived: true.
 *   - allowedIn / allowedOut. Lifted from the surrounding responses' `next[]`, so the UI can
 *     render the allow-list without re-deriving it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '../src/data/sources/signup-prd-1068894784.md');
const SRC_META = join(here, '../src/data/sources/signup-prd-1068894784.meta.json');
const OUT = join(here, '../src/data/signupPrd.generated.json');

const problems = [];
const fail = (msg) => problems.push(msg);

/* ── read + pin ──────────────────────────────────────────────────────────── */

const raw = readFileSync(SRC, 'utf8');
/* The source file is the Confluence REST payload; the prose lives in `.body`. Accept either
   the raw payload or an already-extracted markdown body, so re-fetching is low-ceremony. */
let md;
try {
  md = JSON.parse(raw).body;
} catch {
  md = raw;
}
if (typeof md !== 'string' || !md.includes('## Scenario 1:')) {
  console.error('FATAL: source does not look like the signup PRD body.');
  process.exit(1);
}
const sourceSha256 = createHash('sha256').update(raw).digest('hex');

/* Provenance. The .md is normally just the page body, so the Confluence envelope metadata lives in
   a sibling .meta.json. If someone saves the whole REST payload instead, read it from there. */
let docMeta = {};
try {
  docMeta = JSON.parse(readFileSync(SRC_META, 'utf8'));
} catch {
  try {
    const p = JSON.parse(raw);
    docMeta = { title: p.title, version: p.version?.number, updatedAt: p.version?.createdAt };
  } catch { /* neither available — meta fields stay null */ }
}
if (docMeta.version == null) {
  console.warn('warning: no source version found (expected signup-prd-1068894784.meta.json)');
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const FENCE = /```\n([\s\S]*?)\n```/g;

/**
 * Collapse whitespace and flatten the PRD's markdown emphasis. Prose is rendered as plain text in
 * the UI, so leaving `**must**` and backticks in would show the markup literally.
 */
const norm = (s) =>
  s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Prose sitting between two fences. Anything from a `###` onward belongs to the NEXT
 *  section, not this step — several gaps in the PRD run straight into the following heading. */
function proseBetween(text) {
  let t = text.replace(/^\s*Response:\s*$/gim, '');
  const h = t.search(/^#{2,4}\s/m);
  if (h !== -1) t = t.slice(0, h);
  t = t.replace(/^_.*_$/gm, ''); // italic editorial asides
  return norm(t) || null;
}

function statusFor(body) {
  if (body.authorization_code) return 200;
  if (body.error === 'insufficient_authorization') return 403;
  return null;
}

const actionsOf = (body) =>
  Array.isArray(body?.next) ? body.next.map((n) => n.action) : [];

/* ── milestones ──────────────────────────────────────────────────────────── */

function parseMilestones(text) {
  const sec = text.slice(text.indexOf('## Milestones'), text.indexOf('## Signup state machine'));
  const out = [];
  for (const line of sec.split('\n')) {
    // Data rows only: the Confluence export interleaves repeated `| --- |` separator rows.
    const m = line.match(/^\|\s*\*\*(M\d)\*\*\s*\|(.*)$/);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    const [scope, scenarioCell, adds, epic] = cells;
    const nums = [...(scenarioCell || '').matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    out.push({
      id: m[1],
      scope,
      scenarioNumbers: nums,
      adds: norm((adds || '').replace(/`/g, '')),
      jiraEpic: epic?.trim() || null,
    });
  }
  return out;
}

function parseOpenQuestions(text) {
  const sec = text.slice(text.indexOf('## Open questions'));
  const out = [];
  for (const line of sec.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*(.*?)\s*\|\s*$/);
    if (!m) continue;
    const status = /<custom[^>]*>([^<]*)<\/custom>/.exec(m[3])?.[1] || m[3];
    out.push({ n: Number(m[1]), question: norm(m[2].replace(/`/g, '')), status: status.trim() });
  }
  return out;
}

/* ── scenarios ───────────────────────────────────────────────────────────── */

const scenHeads = [...md.matchAll(/^## Scenario (\d+): (.+)$/gm)];
const openQIdx = md.indexOf('## Open questions');
const milestones = parseMilestones(md);
const milestoneOf = (n) => milestones.find((m) => m.scenarioNumbers.includes(n))?.id ?? null;

/** Which grouping table the scenario came from — single vs multiple identifier. */
function identifierClass(num) {
  return num <= 6 ? 'single' : 'multiple';
}

function parseConfig(section) {
  const rows = [];
  for (const m of section.matchAll(/^\|\s*(Attributes|Phone|Password)\s*\|\s*(.+?)\s*\|$/gm)) {
    rows.push({ setting: m[1], value: m[2].trim() });
  }
  const get = (k) => rows.find((r) => r.setting === k)?.value || '';
  const attrs = get('Attributes');
  const pwd = get('Password');
  const phoneRow = get('Phone');
  const req = (id) => new RegExp(`${id}\\s*\\(required`).test(attrs);
  const opt = (id) => new RegExp(`${id}\\s*\\(optional`).test(attrs);
  const state = (id) =>
    req(id) ? 'required' : opt(id) ? 'optional' : 'disabled';
  return {
    rows,
    derived: {
      email: state('email'),
      // Scenarios 1-3 spell phone's absence in a dedicated row rather than in Attributes.
      phone: /not enabled/i.test(phoneRow) ? 'disabled' : state('phone'),
      password: /not collected/i.test(pwd) ? 'none' : /optional/i.test(pwd) ? 'optional' : 'required',
    },
  };
}

const scenarios = [];
let totalExchanges = 0;

scenHeads.forEach((head, i) => {
  const start = head.index;
  const end = i + 1 < scenHeads.length ? scenHeads[i + 1].index : openQIdx;
  const body = md.slice(start, end);
  const num = Number(head[1]);
  const title = head[2].trim();

  const subs = [...body.matchAll(/^### (.+)$/gm)];
  const sub = (pred) => {
    const idx = subs.findIndex((s) => pred(s[1]));
    if (idx === -1) return null;
    const s = subs[idx].index;
    const e = idx + 1 < subs.length ? subs[idx + 1].index : body.length;
    return { heading: subs[idx][1].trim(), text: body.slice(s, e) };
  };

  const descSec = sub((h) => h === 'Description');
  const cfgSec = sub((h) => h === 'Configuration');
  const altSec = sub((h) => h === 'Alternate paths');

  const config = cfgSec ? parseConfig(cfgSec.text) : { rows: [], derived: {} };

  const happyPaths = [];
  subs
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => /^Happy path \d+/.test(s[1]))
    .forEach(({ s, idx }) => {
      const hs = s.index;
      const he = idx + 1 < subs.length ? subs[idx + 1].index : body.length;
      const sec = body.slice(hs, he);
      const label = s[1].trim();
      const hpNum = Number(/^Happy path (\d+)/.exec(label)[1]);
      const hpTitle = label.replace(/^Happy path \d+:?\s*/, '').trim();

      /* Fences, in document order, with their positions so prose gaps can be recovered. */
      FENCE.lastIndex = 0;
      const fences = [];
      let fm;
      while ((fm = FENCE.exec(sec))) {
        fences.push({ text: fm[1], start: fm.index, end: fm.index + fm[0].length });
      }

      if (fences.length === 0) return;
      if (fences.length % 2 !== 0) {
        fail(`S${num} ${label}: odd fence count (${fences.length}) — request/response unpaired`);
        return;
      }

      /* The numbered prose list. Verified 1:1 with exchange count across all 26 paths. */
      const preamble = sec.slice(0, fences[0].start);
      /* Titles read as prose, so drop a trailing "(identify:email)"-style parenthetical that only
         repeats the action — the payload right below already shows it. A parenthetical containing
         spaces ("(most complete)") is real prose and stays. */
      const stepLabels = [...preamble.matchAll(/^\d+\.\s+(.+)$/gm)].map((m) =>
        norm(m[1].replace(/`/g, ''))
          .replace(/\s*\([a-z][a-z0-9_:]*\)/gi, '')
          .trim()
      );
      const intro = norm(
        preamble.replace(/^### .*$/m, '').replace(/^\d+\.\s+.+$/gm, '').replace(/^Steps:\s*$/gm, '')
      ) || null;

      const exchanges = [];
      for (let k = 0; k < fences.length; k += 2) {
        const reqF = fences[k];
        const resF = fences[k + 1];
        const xi = k / 2;

        const lines = reqF.text.split('\n');
        if (lines[0].trim() !== 'POST /e/authorize') {
          fail(`S${num} ${label} ex${xi}: request fence starts "${lines[0].trim()}"`);
          continue;
        }
        /* The line immediately before a response fence must be "Response:" — this is what
           guarantees the alternation is real and not a coincidence of ordering. */
        const between = sec.slice(reqF.end, resF.start);
        if (!/^\s*Response:\s*$/m.test(between)) {
          fail(`S${num} ${label} ex${xi}: no "Response:" label before response fence`);
          continue;
        }

        let reqBody, resBody;
        try {
          reqBody = JSON.parse(lines.slice(1).join('\n'));
        } catch (e) {
          fail(`S${num} ${label} ex${xi}: request JSON invalid — ${e.message}`);
          continue;
        }
        try {
          resBody = JSON.parse(resF.text);
        } catch (e) {
          fail(`S${num} ${label} ex${xi}: response JSON invalid — ${e.message}`);
          continue;
        }

        const status = statusFor(resBody);
        if (status === null) fail(`S${num} ${label} ex${xi}: cannot derive status`);

        const prevRes = exchanges[xi - 1]?.response.body;
        exchanges.push({
          index: xi,
          label: stepLabels[xi] ?? null,
          note: proseBetween(sec.slice(xi === 0 ? fences[0].end : fences[k - 1].end, reqF.start)),
          request: { method: 'POST', path: '/e/authorize', body: reqBody },
          response: { status, statusDerived: true, body: resBody },
          allowedIn: prevRes ? actionsOf(prevRes) : [],
          allowedOut: actionsOf(resBody),
          sessionIn: reqBody.auth_session ?? null,
          sessionOut: resBody.auth_session ?? null,
          raw: { request: reqF.text, response: resF.text },
        });
      }

      if (stepLabels.length !== exchanges.length) {
        fail(
          `S${num} ${label}: ${stepLabels.length} numbered steps vs ${exchanges.length} exchanges`
        );
      }

      totalExchanges += exchanges.length;
      happyPaths.push({
        id: `signup-${String(num).padStart(2, '0')}-hp${hpNum}`,
        number: hpNum,
        label,
        title: hpTitle,
        intro,
        stepLabels,
        exchanges,
      });
    });

  scenarios.push({
    id: `signup-${String(num).padStart(2, '0')}`,
    number: num,
    title,
    identifierClass: identifierClass(num),
    milestone: milestoneOf(num),
    description: descSec ? norm(descSec.text.replace(/^### .*$/m, '')) : null,
    alternatePaths: altSec ? norm(altSec.text.replace(/^### .*$/m, '').replace(/^_|_$/g, '')) : null,
    config,
    happyPaths,
  });
});

/* ── derived catalogues (computed here so the UI is a pure render) ────────── */

const allExchanges = scenarios.flatMap((s) =>
  s.happyPaths.flatMap((hp) =>
    hp.exchanges.map((x) => ({ ...x, scenario: s.number, happyPath: hp.number, hpId: hp.id }))
  )
);

/** The distinct shapes a `next[]` entry takes — the thing an SDK has to switch on. */
const nextShapes = (() => {
  const m = new Map();
  for (const x of allExchanges) {
    for (const n of x.response.body.next || []) {
      const key = JSON.stringify(Object.keys(n).sort());
      if (!m.has(key)) {
        m.set(key, { fields: Object.keys(n).sort(), occurrences: 0, example: n, firstSeen: null });
      }
      const e = m.get(key);
      e.occurrences += 1;
      e.firstSeen ??= { scenario: x.scenario, happyPath: x.happyPath, exchange: x.index };
    }
  }
  return [...m.values()].sort((a, b) => b.occurrences - a.occurrences);
})();

/** Per-action: the request fields actually sent, and the next-entry fields actually emitted. */
const actionCatalog = (() => {
  const m = new Map();
  const touch = (a) => {
    if (!m.has(a)) {
      m.set(a, { action: a, requestFields: {}, emitsFields: {}, sends: 0, seenIn: [] });
    }
    return m.get(a);
  };
  for (const x of allExchanges) {
    const a = x.request.body.action;
    if (a) {
      const e = touch(a);
      e.sends += 1;
      if (e.seenIn.length < 5) {
        e.seenIn.push({ scenario: x.scenario, happyPath: x.happyPath, exchange: x.index });
      }
      for (const [k, v] of Object.entries(x.request.body)) {
        if (k === 'action' || k === 'auth_session') continue;
        (e.requestFields[k] ??= { name: k, occurrences: 0, examples: [] }).occurrences += 1;
        const ex = e.requestFields[k].examples;
        if (typeof v !== 'object' && !ex.includes(v) && ex.length < 4) ex.push(v);
      }
    }
    for (const n of x.response.body.next || []) {
      const e = touch(n.action);
      for (const k of Object.keys(n)) {
        if (k === 'action') continue;
        (e.emitsFields[k] ??= { name: k, occurrences: 0 }).occurrences += 1;
      }
    }
  }
  return [...m.values()]
    .map((e) => ({
      ...e,
      requestFields: Object.values(e.requestFields).sort((a, b) => b.occurrences - a.occurrences),
      emitsFields: Object.values(e.emitsFields).sort((a, b) => b.occurrences - a.occurrences),
    }))
    .sort((a, b) => a.action.localeCompare(b.action));
})();

/* ── assertions ──────────────────────────────────────────────────────────── */

const counts = {
  scenarios: scenarios.length,
  happyPaths: scenarios.reduce((n, s) => n + s.happyPaths.length, 0),
  exchanges: totalExchanges,
  nextShapes: nextShapes.length,
  actions: actionCatalog.length,
};

if (counts.scenarios !== 15) fail(`expected 15 scenarios, got ${counts.scenarios}`);
if (counts.happyPaths !== 26) fail(`expected 26 happy paths, got ${counts.happyPaths}`);
if (counts.exchanges !== 200) fail(`expected 200 exchanges, got ${counts.exchanges}`);

/* Milestones must partition scenarios 1..15 exactly once. */
const covered = milestones.flatMap((m) => m.scenarioNumbers).sort((a, b) => a - b);
if (covered.join(',') !== Array.from({ length: 15 }, (_, i) => i + 1).join(',')) {
  fail(`milestones do not partition 1..15 exactly once: got [${covered}]`);
}

/* Structural round-trip: the emitted body must equal a fresh parse of the raw fence, and must
   survive a serialize/parse cycle. Deliberately structural — a byte-exact text comparison would
   fail only because the PRD writes `next` entries inline while JSON.stringify expands them. */
for (const x of allExchanges) {
  const reqAgain = JSON.parse(x.raw.request.split('\n').slice(1).join('\n'));
  const resAgain = JSON.parse(x.raw.response);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!eq(reqAgain, x.request.body)) fail(`S${x.scenario} hp${x.happyPath} ex${x.index}: request round-trip`);
  if (!eq(resAgain, x.response.body)) fail(`S${x.scenario} hp${x.happyPath} ex${x.index}: response round-trip`);
}

/* Session chaining: exchange N sends the auth_session exchange N-1 returned. */
for (const s of scenarios) {
  for (const hp of s.happyPaths) {
    hp.exchanges.forEach((x, i) => {
      if (i === 0) {
        if (x.sessionIn) fail(`${hp.id} ex0 should not send auth_session`);
        if (!x.request.body.client_id) fail(`${hp.id} ex0 should send client_id`);
      } else if (x.sessionIn !== hp.exchanges[i - 1].sessionOut) {
        fail(`${hp.id} ex${i}: sends ${x.sessionIn}, previous returned ${hp.exchanges[i - 1].sessionOut}`);
      }
    });
    const last = hp.exchanges.at(-1);
    if (!last.response.body.authorization_code) fail(`${hp.id}: last response has no authorization_code`);
    if (last.response.body.next) fail(`${hp.id}: last response still carries next[]`);
  }
}

/* Allow-list integrity — this tests the PRD, not the parser. Every action sent must have been
   offered by the previous response's next[]. A failure here is a documentation bug worth filing. */
const allowViolations = [];
for (const s of scenarios) {
  for (const hp of s.happyPaths) {
    hp.exchanges.forEach((x, i) => {
      if (i === 0) return;
      const a = x.request.body.action;
      if (a && !x.allowedIn.includes(a)) {
        allowViolations.push(`${hp.id} ex${i}: sends ${a}, previous next[] offered [${x.allowedIn}]`);
      }
    });
  }
}

/* ── report + write ──────────────────────────────────────────────────────── */

console.log('counts          ', counts);
console.log('milestones      ', milestones.map((m) => `${m.id}{${m.scenarioNumbers}}`).join(' '));
console.log('distinct actions', actionCatalog.map((a) => a.action.replace(/^action:|:v1$/g, '')).join(', '));
console.log('next shapes     ', nextShapes.length);

if (allowViolations.length) {
  console.log(`\n⚠ allow-list violations in the PRD (${allowViolations.length}):`);
  for (const v of allowViolations.slice(0, 20)) console.log('  -', v);
} else {
  console.log('allow-list      every action sent was offered by the previous next[] ✓');
}

if (problems.length) {
  console.error(`\nFATAL — ${problems.length} problem(s), nothing written:`);
  for (const p of problems.slice(0, 40)) console.error('  -', p);
  process.exit(1);
}

const out = {
  meta: {
    sourceId: '1068894784',
    sourceTitle: docMeta.title ?? 'PRD: Embedded Authorize - Signup',
    space: docMeta.space ?? 'IAMEA',
    url: docMeta.url ?? 'https://oktainc.atlassian.net/wiki/spaces/IAMEA/pages/1068894784',
    sourceVersion: docMeta.version ?? null,
    sourceUpdatedAt: docMeta.updatedAt ?? null,
    docStatus: docMeta.docStatus ?? null,
    sourceSha256,
    generatedBy: 'scripts/extract-signup-prd.mjs',
    statusDerived: true,
    statusDerivation:
      'The PRD prints response bodies with no status line. authorization_code present → 200; ' +
      'error: insufficient_authorization → 403. Statuses here are inferred, not quoted.',
    supersededBy: {
      url: 'https://oktainc.atlassian.net/wiki/x/DkCyJQ',
      title: 'PRD - Embedded Session and Factor Selection',
      note:
        'The signup PRD carries a "superseded by" banner pointing here. That page is an ' +
        'initiative-level PRD for an older /start + /continue endpoint model and does not ' +
        'describe /e/authorize, so page 1068894784 remains the only concrete source for these ' +
        'call sequences.',
    },
    counts,
    allowListViolations: allowViolations,
  },
  milestones,
  openQuestions: parseOpenQuestions(md),
  scenarios,
  derived: { nextShapes, actionCatalog },
};

writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`\nwrote ${OUT}`);
