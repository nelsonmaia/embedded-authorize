/**
 * The contract, without running anything — for someone writing an SDK who needs to know what a
 * call takes and what comes back.
 *
 * Every number here is counted from the modelled call sequences, so "18×" means eighteen real
 * calls carried that field. Nothing is aspirational and nothing is hand-maintained.
 */
import { Badge } from '@/components/ui/badge';
import { JsonView } from '@/components/JsonCode.jsx';
import { NEXT_SHAPES, ACTION_CATALOG, PRD_META } from '@/data/signupPrd.js';
import { CAPABILITIES, byId } from '@/data/spec.js';

const short = (a) => a.replace(/^action:/, '').replace(/:v1$/, '');

/** Where the signup model and the login capability registry describe the same call differently. */
function divergences() {
  const out = [];
  for (const a of ACTION_CATALOG) {
    const cap = byId(a.action);
    if (!cap) continue;
    const declared = new Set((cap.request || []).map((r) => r.name));
    const observed = new Set(a.requestFields.map((f) => f.name));
    for (const f of observed) {
      if (!declared.has(f)) {
        const n = a.requestFields.find((x) => x.name === f).occurrences;
        out.push({ action: a.action, detail: `signup sends ${f} (${n}×); the registry does not list it` });
      }
    }
    for (const r of cap.request || []) {
      if (r.required && !observed.has(r.name)) {
        out.push({
          action: a.action,
          detail: `the registry marks ${r.name} required, but signup never sends it (0 of ${a.sends})`,
        });
      }
    }
  }
  return out;
}

function Section({ title, blurb, children }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {blurb && <p className="mt-1 max-w-[80ch] text-sm leading-relaxed text-muted-foreground">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

function Table({ head, children }) {
  return (
    <div className="overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40">
            {head.map((h) => (
              <th
                key={h}
                className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-widest text-muted-foreground"
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
  <td className={`border-b px-4 py-3 align-top ${mono ? 'font-mono text-xs' : 'text-muted-foreground'} ${className}`}>
    {children}
  </td>
);

export function ContractView() {
  const diffs = divergences();
  const n = PRD_META.counts;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10 px-6 py-6">
      <Section
        title="What each call takes, and what it gives back"
        blurb={`Counted across ${n.exchanges} modelled signup calls covering ${n.scenarios} connection configurations. Occurrence counts are literal.`}
      >
        <Table head={['Action', 'Sent', 'Fields you send', 'Fields on its next[] entry', 'Built?']}>
          {ACTION_CATALOG.map((a) => {
            const cap = byId(a.action);
            return (
              <tr key={a.action} className="hover:bg-muted/30">
                <Td mono className="text-foreground">{short(a.action)}</Td>
                <Td>{a.sends}×</Td>
                <Td mono>
                  {a.requestFields.length === 0
                    ? '—'
                    : a.requestFields.map((f) => (
                        <div key={f.name}>
                          <span className="text-foreground">{f.name}</span>{' '}
                          <span className="text-muted-foreground">
                            {f.examples.map((e) => JSON.stringify(e)).join(' | ')}
                          </span>
                        </div>
                      ))}
                </Td>
                <Td mono>{a.emitsFields.length === 0 ? '—' : a.emitsFields.map((f) => f.name).join(', ')}</Td>
                <Td>
                  {cap?.status === 'live' ? (
                    <Badge variant="ok">working</Badge>
                  ) : cap?.status === 'negotiated' ? (
                    <Badge variant="warn">partial</Badge>
                  ) : (
                    <Badge variant="secondary">not yet</Badge>
                  )}
                </Td>
              </tr>
            );
          })}
        </Table>
      </Section>

      <Section
        title={`The ${NEXT_SHAPES.length} shapes a next[] entry takes`}
        blurb="The complete set an SDK has to switch on for signup — every entry across every call falls into one of these."
      >
        <Table head={['Fields', 'Seen', 'Example']}>
          {NEXT_SHAPES.map((s, i) => (
            <tr key={i} className="hover:bg-muted/30">
              <Td mono className="text-foreground">{s.fields.join(', ')}</Td>
              <Td>{s.occurrences}×</Td>
              <td className="border-b p-0 align-top">
                <JsonView value={s.example} />
              </td>
            </tr>
          ))}
        </Table>
      </Section>

      {diffs.length > 0 && (
        <Section
          title="Where the two models disagree"
          blurb="The signup and sign-in models were written separately and describe some calls differently. Neither is normalised away — an SDK has to handle what actually ships, so both are shown."
        >
          <div className="space-y-2">
            {diffs.map((d, i) => (
              <div
                key={i}
                className="rounded-lg border border-[hsl(var(--warn))]/30 bg-[hsl(var(--warn))]/5 px-4 py-3 text-sm text-muted-foreground"
              >
                <span className="font-mono font-semibold text-[hsl(var(--warn))]">{short(d.action)}</span>{' '}
                — {d.detail}
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section
        title="Everything the protocol can do"
        blurb="All capabilities across sign-in, MFA, signup, federation and passkeys. “Working” means verified against a real tenant, not merely designed."
      >
        <Table head={['Capability', 'Area', 'Built?', 'Fields you send', 'Fields it emits']}>
          {CAPABILITIES.map((c) => (
            <tr key={c.id} className="hover:bg-muted/30">
              <Td mono className="text-foreground">{short(c.id)}</Td>
              <Td>{c.group}</Td>
              <Td>
                {c.status === 'live' ? (
                  <Badge variant="ok">working</Badge>
                ) : c.status === 'negotiated' ? (
                  <Badge variant="warn">partial</Badge>
                ) : (
                  <Badge variant="secondary">not yet</Badge>
                )}
              </Td>
              <Td mono>{(c.request || []).map((r) => r.name).join(', ') || '—'}</Td>
              <Td mono>{(c.emits || []).map((e) => e.name).join(', ') || '—'}</Td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}
