/**
 * The API specification for POST /e/authorize, without running anything.
 *
 * Ordered the way a reference is read rather than the way it was written: the endpoint, the two
 * request shapes, every action, then everything that can come back. Occurrence counts are literal
 * — "18×" means eighteen calls in the modelled sequences carried that field, so a blank is an
 * action nothing has exercised yet.
 *
 * Only what a client sends and receives. Why the contract says what it says lives in the source
 * documents, not here.
 */
import { useState } from 'react';
import { Check, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { JsonView } from '@/components/JsonCode.jsx';
import { specToMarkdown } from '@/data/specMarkdown.js';
import { NEXT_SHAPES, ACTION_CATALOG, PRD_META } from '@/data/signupPrd.js';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  ENDPOINT,
  ERRORS,
  ERROR_DESCRIPTIONS,
  DRAFT,
} from '@/data/spec.js';

const short = (a) => a.replace(/^action:/, '').replace(/:v1$/, '');

/** How many modelled calls carried this action, when any have. */
const sendsFor = (id) => ACTION_CATALOG.find((a) => a.action === id)?.sends ?? null;

function Section({ title, blurb, children }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {blurb && <p className="mt-1 max-w-[85ch] text-sm leading-relaxed text-muted-foreground">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            {head.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const Td = ({ mono, children, className = '' }) => (
  <td
    className={`border-b px-4 py-3 align-top ${mono ? 'font-mono text-xs' : 'text-sm text-muted-foreground'} ${className}`}
  >
    {children}
  </td>
);

/** A field list, used for both request shapes. */
function ParamTable({ params }) {
  return (
    <Table head={['Parameter', '', 'Meaning']}>
      {params.map((p) => (
        <tr key={p.name} className="hover:bg-muted/30">
          <Td mono className="whitespace-nowrap text-foreground">{p.name}</Td>
          <Td className="whitespace-nowrap">
            {p.required ? (
              <span className="font-medium text-foreground">required</span>
            ) : (
              <span className="text-muted-foreground">optional</span>
            )}
          </Td>
          <Td className="max-w-[60ch]">{p.doc}</Td>
        </tr>
      ))}
    </Table>
  );
}

export function ContractView() {
  const n = PRD_META.counts;
  const [exported, setExported] = useState(false);

  /* Generated from the same exports this page renders, so the file cannot drift from the screen. */
  const exportMarkdown = () => {
    const md = specToMarkdown({ generatedAt: new Date().toISOString().slice(0, 10) });
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'e-authorize-api-spec.md';
    a.click();
    URL.revokeObjectURL(url);
    setExported(true);
    setTimeout(() => setExported(false), 1600);
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10 px-6 py-6">
      <Section
        title="The endpoint"
        blurb={`One path, two request shapes. Implements ${DRAFT.id}.`}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 rounded-lg border bg-muted/20 px-4 py-3 font-mono text-sm">
            <span className="font-semibold text-[hsl(var(--ok))]">{ENDPOINT.method}</span>{' '}
            <span className="text-foreground">{ENDPOINT.path}</span>
            <span className="ml-3 text-xs text-muted-foreground">content-type: {ENDPOINT.contentType}</span>
          </div>
          <Button variant="outline" size="sm" onClick={exportMarkdown}>
            {exported ? <Check /> : <Download />} {exported ? 'Downloaded' : 'Export .md'}
          </Button>
        </div>
      </Section>

      <Section
        title="Opening a session"
        blurb="The first call. It carries no auth_session because it is what creates one."
      >
        <ParamTable params={ENDPOINT.initiate} />
      </Section>

      <Section
        title="Continuing a session"
        blurb="Every call after the first. The response to each one tells you what may come next."
      >
        <ParamTable params={ENDPOINT.continue} />
      </Section>

      <Section
        title="Actions"
        blurb={
          'The complete vocabulary. “Sends” is what the client puts in the request body for that ' +
          'action; “Descriptor” is what the server puts on the entry when it offers that action in ' +
          'next[]. A trailing ? marks an optional field.'
        }
      >
        {CAPABILITY_GROUPS.map((group) => {
          const rows = CAPABILITIES.filter((c) => c.group === group.id);
          if (!rows.length) return null;
          return (
            <div key={group.id} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </h3>
              <Table head={['Action', 'Sends', 'Descriptor', 'Observed']}>
                {rows.map((c) => {
                  const sends = sendsFor(c.id);
                  return (
                    <tr key={c.id} className="hover:bg-muted/30">
                      <Td mono className="whitespace-nowrap text-foreground">{short(c.id)}</Td>
                      <Td mono>
                        {(c.request || []).length === 0
                          ? '—'
                          : c.request.map((r) => (
                              <div key={r.name} className="whitespace-nowrap">
                                <span className="text-foreground">{r.name}</span>
                                {!r.required && <span className="text-muted-foreground">?</span>}
                                {r.example != null && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    {JSON.stringify(r.secret ? '••••' : r.example)}
                                  </span>
                                )}
                              </div>
                            ))}
                      </Td>
                      <Td mono>
                        {(c.emits || []).length === 0
                          ? '—'
                          : c.emits.map((e) => (
                              <div key={e.name} className="whitespace-nowrap">
                                <span className="text-foreground">{e.name}</span>{' '}
                                <span className="text-muted-foreground">{e.value}</span>
                              </div>
                            ))}
                      </Td>
                      <Td className="whitespace-nowrap">{sends != null ? `${sends}×` : '—'}</Td>
                    </tr>
                  );
                })}
              </Table>
            </div>
          );
        })}
      </Section>

      <Section
        title="Responses"
        blurb="Every status and error code the endpoint returns, and what a client should do about each."
      >
        <Table head={['Status', 'error', 'Kind', 'Meaning']}>
          {Object.entries(ERRORS).map(([code, e]) => (
            <tr key={code} className="hover:bg-muted/30">
              <Td mono className="whitespace-nowrap text-foreground">{e.http}</Td>
              <Td mono className="whitespace-nowrap text-foreground">{code}</Td>
              <Td className="whitespace-nowrap">{e.kind}</Td>
              <Td className="max-w-[70ch] whitespace-pre-line">{e.doc}</Td>
            </tr>
          ))}
          <tr className="hover:bg-muted/30">
            <Td mono className="whitespace-nowrap text-foreground">200</Td>
            <Td mono className="whitespace-nowrap text-muted-foreground">—</Td>
            <Td className="whitespace-nowrap">success</Td>
            <Td className="max-w-[70ch]">
              Carries <code className="font-mono text-xs">authorization_code</code> and nothing else.
              Exchange it at POST /oauth/token with the standard authorization_code grant — no new
              grant type is introduced.
            </Td>
          </tr>
        </Table>
      </Section>

      <Section
        title="error_description values"
        blurb={
          'On a 403 this is a coded value rather than prose — the vocabulary a client switches on to ' +
          'tell one failure from another. Recoverable means the session survives and next[] comes ' +
          'back; terminal means there is nothing to continue and the flow restarts. Only ' +
          'invalid_request carries free text instead.'
        }
      >
        <Table head={['Value', '', 'Meaning']}>
          {ERROR_DESCRIPTIONS.map((e) => (
            <tr key={e.code} className="hover:bg-muted/30">
              <Td mono className="whitespace-nowrap text-foreground">{e.code}</Td>
              <Td className="whitespace-nowrap">
                {e.recoverable ? (
                  <span className="text-muted-foreground">recoverable</span>
                ) : (
                  <span className="font-medium text-foreground">terminal</span>
                )}
              </Td>
              <Td className="max-w-[70ch] whitespace-pre-line">{e.doc}</Td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section
        title={`The ${NEXT_SHAPES.length} shapes a next[] entry takes`}
        blurb={`The complete set an SDK has to switch on, counted across ${n.exchanges} modelled calls covering ${n.scenarios} connection configurations.`}
      >
        <Table head={['Fields', 'Seen', 'Example']}>
          {NEXT_SHAPES.map((s, i) => (
            <tr key={i} className="hover:bg-muted/30">
              <Td mono className="whitespace-nowrap text-foreground">{s.fields.join(', ')}</Td>
              <Td className="whitespace-nowrap">{s.occurrences}×</Td>
              <td className="border-b p-0 align-top">
                <JsonView value={s.example} />
              </td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
