/**
 * Browser click-through, driven over the Chrome DevTools Protocol.
 *
 *   npm run dev            # in another terminal
 *   node tests/e2e-browser.mjs
 *
 * Not part of `npm test` — it needs a running dev server and a real Chrome. Uses Node's global
 * WebSocket, so there is no automation dependency to install.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_UNDER_TEST = process.env.E2E_URL || 'http://localhost:5177/';
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${ok || !detail ? '' : `\n    ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = mkdtempSync(join(tmpdir(), 'e2e-chrome-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1500,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Chrome did not expose a debugging target');
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          msg.params.exceptionDetails.text +
            ' ' +
            (msg.params.exceptionDetails.exception?.description || '')
        );
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  /**
   * A real, trusted mouse click at an element's centre.
   *
   * Radix primitives activate on pointer events and ignore a synthetic `el.click()` — tabs in
   * particular stay inactive. Driving trusted input exercises the same path a person does, so the
   * test cannot pass or fail for reasons a user would never hit.
   */
  async clickReal(findExpr) {
    const box = await this.eval(`
      const el = ${findExpr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    `);
    if (!box) throw new Error(`clickReal: no element for ${findExpr}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
    await sleep(120);
  }
}

/* Helpers injected into the page — React-friendly value setting and button lookup by text. */
const HELPERS = `
  window.__t = {
    btn: (t) => [...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith(t)),
    ta:  () => document.querySelector('textarea'),
    setTa: (v) => {
      const el = document.querySelector('textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    cards: () => [...document.querySelectorAll('[data-x-card]')],
    wait: (ms) => new Promise(r => setTimeout(r, ms)),
  };
`;

let cdp;
let exitCode = 0;

try {
  const ws = new WebSocket(await targetWs());
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  cdp = new CDP(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: URL_UNDER_TEST });

  const mounted = await cdp.eval(`
    for (let i = 0; i < 80; i++) {
      if (document.querySelector('textarea')) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  `);
  check('app mounts', mounted);
  await cdp.eval(HELPERS + 'return true;');

  /* ── the payload is editable immediately, with no button to press first ─── */

  const editable = await cdp.eval(`
    const ta = __t.ta();
    return {
      exists: !!ta,
      readOnly: ta?.readOnly ?? null,
      disabled: ta?.disabled ?? null,
      hasClientId: (ta?.value || '').includes('client_id'),
      noEditButton: !__t.btn('edit') && !__t.btn('Edit'),
      hasSend: !!__t.btn('Send'),
    };
  `);
  check('the request is a live textarea on first paint', editable.exists && !editable.readOnly && !editable.disabled);
  check('it is prefilled with a suggested payload', editable.hasClientId);
  check('there is no "edit" button to press first', editable.noEditButton);
  check('Send is available immediately', editable.hasSend);

  /* ── typing in it works, and what you typed is what gets sent ──────────── */

  const typed = await cdp.eval(`
    const before = __t.ta().value;
    __t.setTa(before.replace('"clientId"', '"MY_OWN_CLIENT"'));
    await __t.wait(150);
    const after = __t.ta().value;
    return { changed: after.includes('MY_OWN_CLIENT'), stillJson: (() => { try { JSON.parse(after); return true } catch { return false } })() };
  `);
  check('typing into the request updates it', typed.changed && typed.stillJson);

  const sentEdited = await cdp.eval(`
    __t.btn('Send').click();
    await __t.wait(350);
    const pres = [...document.querySelectorAll('pre')].map(p => p.textContent);
    return {
      sentOurValue: pres.some(t => t.includes('MY_OWN_CLIENT')),
      editedBadge: [...document.querySelectorAll('div')].some(d => d.textContent.trim() === 'edited'),
      gotResponse: pres.some(t => t.includes('insufficient_authorization')),
    };
  `);
  check('the edited value is actually sent', sentEdited.sentOurValue);
  check('the edited call is flagged', sentEdited.editedBadge);
  check('a response comes back', sentEdited.gotResponse);

  /* ── invalid JSON is reported and blocks sending ───────────────────────── */

  const bad = await cdp.eval(`
    const keep = __t.ta().value;
    __t.setTa('{ nope');
    await __t.wait(200);
    const blocked = __t.btn('Send')?.disabled === true;
    const shown = document.body.textContent.includes('Unexpected') || !!document.querySelector('.text-destructive');
    __t.setTa(keep);
    await __t.wait(150);
    return { blocked, shown, recovered: __t.btn('Send')?.disabled === false };
  `);
  check('invalid JSON blocks Send', bad.blocked);
  check('invalid JSON is reported', bad.shown);
  check('fixing the JSON re-enables Send', bad.recovered);

  /* ── flow picking is one dropdown of plain-language names ──────────────── */

  const picker = await cdp.eval(`
    const combos = document.querySelectorAll('[role="combobox"]');
    combos[0].click();
    await __t.wait(400);
    const opts = [...document.querySelectorAll('[role="option"]')].map(o => o.textContent.trim());
    const groups = [...document.querySelectorAll('[role="group"] > div:first-child')].map(g => g.textContent.trim());
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await __t.wait(250);
    return { comboCount: combos.length, opts, groups };
  `);
  check('flow selection is a single dropdown', picker.comboCount >= 1, `${picker.comboCount} comboboxes`);
  check(
    'it is grouped into sign up and sign in',
    picker.groups.join('|').toLowerCase().includes('sign up') &&
      picker.groups.join('|').toLowerCase().includes('sign in'),
    JSON.stringify(picker.groups)
  );
  check(
    'options are plain-language configurations',
    picker.opts.some((o) => /Email · no password/.test(o)) &&
      picker.opts.some((o) => /Email, phone optional/.test(o)),
    JSON.stringify(picker.opts.slice(0, 6))
  );

  /* ── no PRD / milestone / delivery language anywhere in the UI ─────────── */

  const language = await cdp.eval(`
    const t = document.body.innerText;
    const bad = ['PRD', 'Confluence', '1068894784', 'Milestone', 'M1', 'M2', 'M3', 'M4', 'M5',
                 'superseded', 'Happy path', 'Scenario 8', 'deliverable'];
    return { found: bad.filter(w => new RegExp('\\\\b' + w + '\\\\b').test(t)) };
  `);
  check('no PRD or milestone language in the console', language.found.length === 0, `found: ${language.found.join(', ')}`);

  /* ── walk a whole flow to completion ──────────────────────────────────── */

  const walk = await cdp.eval(`
    // Pick the fullest signup flow: email + optional phone + optional password.
    document.querySelectorAll('[role="combobox"]')[0].click();
    await __t.wait(400);
    const opt = [...document.querySelectorAll('[role="option"]')]
      .find(o => o.textContent.includes('Email, phone optional · optional password'));
    if (!opt) return { ok: false, why: 'flow not found' };
    opt.click();
    await __t.wait(400);

    // Then the fullest variant.
    const combos = document.querySelectorAll('[role="combobox"]');
    if (combos.length < 2) return { ok: false, why: 'no variant dropdown' };
    combos[1].click();
    await __t.wait(400);
    const v = [...document.querySelectorAll('[role="option"]')].find(o => /fullest path/.test(o.textContent));
    if (!v) return { ok: false, why: 'fullest variant not found' };
    v.click();
    await __t.wait(450);

    const log = [];
    for (let i = 0; i < 26; i++) {
      const send = __t.btn('Send');
      if (send && !send.disabled) { send.click(); await __t.wait(200); log.push('send'); continue; }
      const chips = [...document.querySelectorAll('button')].filter(b => /^[a-z]+:[a-z:]+/.test(b.textContent.trim()));
      if (chips.length) { chips[0].click(); await __t.wait(180); log.push('pick'); continue; }
      break;
    }
    const pres = [...document.querySelectorAll('pre')].map(p => p.textContent);
    return {
      ok: true, log,
      calls: document.querySelectorAll('[class*="rounded-full"]').length,
      gotCode: pres.some(t => t.includes('authorization_code')),
      doneBanner: /authorization code was issued/i.test(document.body.innerText),
      titles: [...document.querySelectorAll('span.truncate')].map(s => s.textContent.trim()),
    };
  `);
  check('can select a multi-variant flow and its variant', walk.ok, walk.why);
  check('the flow runs to an authorization code', walk.gotCode === true, JSON.stringify(walk.log));
  check('a completion note explains what to do next', walk.doneBanner === true);
  check(
    'each call is titled in plain language',
    (walk.titles || []).length >= 10 &&
      walk.titles.every((t) => t && !/\bv1\b/.test(t)),
    JSON.stringify(walk.titles)
  );

  /* ── login simulator still reachable and honest about being simulated ─── */

  const login = await cdp.eval(`
    document.querySelectorAll('[role="combobox"]')[0].click();
    await __t.wait(400);
    const groups = [...document.querySelectorAll('[role="group"]')];
    const signIn = groups[groups.length - 1];
    const opt = signIn.querySelectorAll('[role="option"]')[0];
    const label = opt.textContent.trim();
    opt.click();
    await __t.wait(450);
    const ta = __t.ta();
    return { label, prefilled: (ta?.value || '').includes('capabilities'), editable: ta && !ta.readOnly };
  `);
  check('sign-in flows are selectable from the same dropdown', !!login.label, login.label);
  check('sign-in flows are also prefilled and editable', login.prefilled && login.editable);

  /* ── live tenant is framed as testing what exists now ─────────────────── */

  await cdp.clickReal(`[...document.querySelectorAll('[role="tab"]')].find(t => /Live tenant/.test(t.textContent))`);
  await sleep(500);
  const live = await cdp.eval(`
    const tab = [...document.querySelectorAll('[role="tab"]')].find(t => /Live tenant/.test(t.textContent));
    const labels = [...document.querySelectorAll('label')].map(l => l.textContent.trim());
    return {
      active: tab.getAttribute('data-state') === 'active',
      labels,
      hasSecret: labels.some(l => /secret/i.test(l)),
      framing: document.body.innerText,
    };
  `);
  check('the Live tenant tab activates', live.active);
  check('live mode asks for tenant domain and client ID inline', live.labels.includes('Tenant domain') && live.labels.includes('Client ID'));
  check('live mode offers no client_secret field', live.hasSecret === false);
  check('live mode is framed as testing what works today', /right now/i.test(live.framing));
  check('live mode explains the Postman-style call path', /Postman/i.test(live.framing));

  /* ── contract view ────────────────────────────────────────────────────── */

  const contract = await cdp.eval(`
    __t.btn('Full contract').click();
    await __t.wait(500);
    const t = document.body.innerText;
    const rows = document.querySelectorAll('tbody tr').length;
    const bad = ['PRD', 'Confluence', 'Milestone', 'Delivery order', 'Open questions', 'superseded'];
    return { rows, tables: document.querySelectorAll('table').length,
             leaks: bad.filter(w => t.includes(w)),
             hasWorking: /working/.test(t), hasNotYet: /not yet/.test(t) };
  `);
  check('contract view renders its tables', contract.tables >= 3 && contract.rows > 30, `${contract.tables} tables / ${contract.rows} rows`);
  check('contract view has no PRD or milestone language', contract.leaks.length === 0, contract.leaks.join(', '));
  check('capabilities are marked working vs not yet built', contract.hasWorking && contract.hasNotYet);

  const realErrors = cdp.consoleErrors.filter((e) => !/favicon|React DevTools/i.test(e));
  check('no console errors', realErrors.length === 0, realErrors.join('\n    '));
} catch (err) {
  check('harness ran to completion', false, err.stack || String(err));
} finally {
  try { cdp?.ws.close(); } catch {}
  chrome.kill('SIGKILL');
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\nfailed:');
  for (const f of failed) console.log(`  ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  exitCode = 1;
}
process.exit(exitCode);
