/**
 * The API Spec page, as Markdown.
 *
 * Built from exactly the same exports the page renders, so the document and the screen cannot
 * disagree — there is no second copy of the contract to keep in step. Anything that belongs in
 * the file belongs in `spec.js` first.
 *
 * Pipes inside cell text would break the table, so every cell is escaped; newlines inside a doc
 * string become spaces, because a Markdown table row cannot contain them.
 */
import { NEXT_SHAPES, PRD_META, ACTION_CATALOG } from './signupPrd.js';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  ENDPOINT,
  ERRORS,
  ERROR_DESCRIPTIONS,
  DRAFT,
  VERIFIED_AGAINST,
} from './spec.js';

const short = (a) => a.replace(/^action:/, '').replace(/:v1$/, '');

/** One table cell: no pipes, no line breaks, collapsed whitespace. */
const cell = (v) =>
  String(v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

const table = (head, rows) =>
  [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');

const sendsFor = (id) => ACTION_CATALOG.find((a) => a.action === id)?.sends ?? null;

const fieldList = (fields, render) =>
  !fields?.length ? '—' : fields.map(render).join('<br>');

/**
 * @param {{ generatedAt?: string }} [opts] timestamp for the header; omit for a stable document.
 */
export function specToMarkdown({ generatedAt } = {}) {
  const n = PRD_META.counts;
  const out = [];

  out.push('# POST /e/authorize — API specification');
  out.push('');
  out.push(
    `Implements [${DRAFT.id}](${DRAFT.url}). Occurrence counts are literal: "18×" means eighteen ` +
      `calls in the ${n.exchanges} modelled exchanges carried that field, across ${n.scenarios} ` +
      'connection configurations. A blank count is an action nothing has exercised yet.'
  );
  out.push('');
  out.push(
    `Verified against \`${VERIFIED_AGAINST.tenant}\` on ${VERIFIED_AGAINST.date}: ` +
      `${VERIFIED_AGAINST.note}`
  );
  if (generatedAt) {
    out.push('');
    out.push(`_Exported ${generatedAt}._`);
  }

  out.push('');
  out.push('## The endpoint');
  out.push('');
  out.push('```http');
  out.push(`${ENDPOINT.method} ${ENDPOINT.path}`);
  out.push(`content-type: ${ENDPOINT.contentType}`);
  out.push('```');

  for (const [title, params, blurb] of [
    ['Opening a session', ENDPOINT.initiate, 'The first call. It carries no `auth_session` because it is what creates one.'],
    ['Continuing a session', ENDPOINT.continue, 'Every call after the first. The response to each one tells you what may come next.'],
  ]) {
    out.push('');
    out.push(`## ${title}`);
    out.push('');
    out.push(blurb);
    out.push('');
    out.push(
      table(
        ['Parameter', '', 'Meaning'],
        params.map((p) => [`\`${p.name}\``, p.required ? '**required**' : 'optional', p.doc])
      )
    );
  }

  out.push('');
  out.push('## Actions');
  out.push('');
  out.push(
    'The complete vocabulary. **Sends** is what the client puts in the request body for that ' +
      'action; **Descriptor** is what the server puts on the entry when it offers that action in ' +
      '`next[]`. A trailing `?` marks an optional field.'
  );

  for (const group of CAPABILITY_GROUPS) {
    const rows = CAPABILITIES.filter((c) => c.group === group.id);
    if (!rows.length) continue;
    out.push('');
    out.push(`### ${group.label}`);
    out.push('');
    out.push(
      table(
        ['Action', 'Sends', 'Descriptor', 'Observed'],
        rows.map((c) => {
          const sends = sendsFor(c.id);
          return [
            `\`${short(c.id)}\``,
            fieldList(c.request, (r) =>
              `\`${r.name}\`${r.required ? '' : '?'}` +
              (r.example != null ? ` ${JSON.stringify(r.secret ? '••••' : r.example)}` : '')
            ),
            fieldList(c.emits, (e) => `\`${e.name}\` ${e.value}`),
            sends != null ? `${sends}×` : '—',
          ];
        })
      )
    );
  }

  out.push('');
  out.push('## Responses');
  out.push('');
  out.push(
    table(
      ['Status', '`error`', 'Kind', 'Meaning'],
      [
        ...Object.entries(ERRORS).map(([code, e]) => [e.http, `\`${code}\``, e.kind, e.doc]),
        [
          '200',
          '—',
          'success',
          'Carries `authorization_code` and nothing else. Exchange it at POST /oauth/token with ' +
            'the standard authorization_code grant — no new grant type is introduced.',
        ],
      ]
    )
  );

  out.push('');
  out.push('## `error_description` values');
  out.push('');
  out.push(
    'On a 403 this is a coded value rather than prose — the vocabulary a client switches on to ' +
      'tell one failure from another. Recoverable means the session survives and `next[]` comes ' +
      'back; terminal means there is nothing to continue and the flow restarts. Only ' +
      '`invalid_request` carries free text instead.'
  );
  out.push('');
  out.push(
    table(
      ['Value', '', 'Meaning'],
      ERROR_DESCRIPTIONS.map((e) => [
        `\`${e.code}\``,
        e.recoverable ? 'recoverable' : '**terminal**',
        e.doc,
      ])
    )
  );

  out.push('');
  out.push(`## The ${NEXT_SHAPES.length} shapes a \`next[]\` entry takes`);
  out.push('');
  out.push('The complete set an SDK has to switch on.');
  for (const s of NEXT_SHAPES) {
    out.push('');
    out.push(`### \`${s.fields.join(', ')}\` — seen ${s.occurrences}×`);
    out.push('');
    out.push('```json');
    out.push(JSON.stringify(s.example, null, 2));
    out.push('```');
  }

  out.push('');
  return out.join('\n');
}
