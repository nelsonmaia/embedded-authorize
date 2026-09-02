/**
 * The Markdown export, and the two colour palettes.
 *
 * The export is generated from the same modules the page renders, so the risk is not that it is
 * wrong today — it is that something is added to the contract and silently omitted from the file.
 * These assertions are mostly completeness checks against the source data for that reason.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { specToMarkdown } from '../src/data/specMarkdown.js';
import {
  CAPABILITIES,
  ENDPOINT,
  ERRORS,
  ERROR_DESCRIPTIONS,
  DRAFT,
} from '../src/data/spec.js';
import { NEXT_SHAPES } from '../src/data/signupPrd.js';

const short = (a) => a.replace(/^action:/, '').replace(/:v1$/, '');

test('the export names the endpoint and the draft it implements', () => {
  const md = specToMarkdown();
  assert.match(md, /^# POST \/e\/authorize/);
  assert.ok(md.includes(`${ENDPOINT.method} ${ENDPOINT.path}`));
  assert.ok(md.includes(DRAFT.id), 'a reader must be able to tell which revision this follows');
});

test('every parameter, action, error and descriptor value reaches the file', () => {
  const md = specToMarkdown();

  for (const p of [...ENDPOINT.initiate, ...ENDPOINT.continue]) {
    assert.ok(md.includes(`\`${p.name}\``), `missing parameter ${p.name}`);
  }
  for (const c of CAPABILITIES) {
    assert.ok(md.includes(`\`${short(c.id)}\``), `missing action ${c.id}`);
  }
  for (const code of Object.keys(ERRORS)) {
    assert.ok(md.includes(`\`${code}\``), `missing error ${code}`);
  }
  for (const e of ERROR_DESCRIPTIONS) {
    assert.ok(md.includes(`\`${e.code}\``), `missing error_description ${e.code}`);
  }
  assert.equal(
    (md.match(/^### `.*` — seen \d+×$/gm) ?? []).length,
    NEXT_SHAPES.length,
    'every next[] shape needs its own example'
  );
});

test('no table row is broken by a pipe or a newline', () => {
  // Doc strings contain both. An unescaped pipe silently shifts every column after it.
  for (const line of specToMarkdown().split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, -1).split(/(?<!\\)\|/);
    assert.ok(cells.length >= 2, `row collapsed: ${line.slice(0, 70)}`);
  }
});

test('every table has a header separator and consistent column counts', () => {
  const lines = specToMarkdown().split('\n');
  for (const [i, line] of lines.entries()) {
    if (!line.startsWith('|') || !/^\|\s*---/.test(lines[i + 1] ?? '')) continue;

    const width = (l) => l.slice(1, -1).split(/(?<!\\)\|/).length;
    const expected = width(line);
    for (let j = i + 1; j < lines.length && lines[j].startsWith('|'); j++) {
      assert.equal(width(lines[j]), expected, `ragged table row: ${lines[j].slice(0, 70)}`);
    }
  }
});

test('the timestamp is opt-in, so the document is stable by default', () => {
  // Two exports of an unchanged contract should be byte-identical — otherwise committing the file
  // produces a diff on every export.
  assert.equal(specToMarkdown(), specToMarkdown());
  assert.ok(!specToMarkdown().includes('Exported'));
  assert.ok(specToMarkdown({ generatedAt: '2026-09-02' }).includes('_Exported 2026-09-02._'));
});

test('secrets are never exported as example values', () => {
  const md = specToMarkdown();
  for (const c of CAPABILITIES) {
    for (const r of c.request ?? []) {
      if (r.secret && r.example) {
        assert.ok(!md.includes(r.example), `${c.id} exported the ${r.name} example verbatim`);
      }
    }
  }
});

/* ── themes ─────────────────────────────────────────────────────────────── */

test('light and dark define exactly the same tokens', () => {
  // A token defined in only one palette is a colour that vanishes when the theme flips — which is
  // how the JSON syntax highlighting used to be a hard-coded pastel, invisible on white.
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.notEqual(at, -1, `${selector} block not found`);
    return css.slice(at, css.indexOf('\n  }', at));
  };
  const tokens = (s) => new Set([...s.matchAll(/^\s*(--[a-z-]+):/gm)].map((m) => m[1]));

  const light = tokens(block(':root'));
  const dark = tokens(block('.dark'));

  const onlyLight = [...light].filter((t) => !dark.has(t) && t !== '--radius');
  const onlyDark = [...dark].filter((t) => !light.has(t));
  assert.deepEqual(onlyLight, [], 'tokens missing from the dark palette');
  assert.deepEqual(onlyDark, [], 'tokens missing from the light palette');
});

test('no syntax colour is hard-coded outside a token', () => {
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8');
  for (const line of css.split('\n')) {
    if (!line.startsWith('.tok-')) continue;
    assert.match(line, /hsl\(var\(--/, `hard-coded colour: ${line.trim()}`);
  }
});

test('the theme is applied before first paint', () => {
  // In React it would flash the wrong theme on every load, which is worse than not offering one.
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /classList\.toggle\('dark'/);
  assert.ok(html.indexOf('eplay-theme') < html.indexOf('src/main.jsx'), 'must run before the app');
});
