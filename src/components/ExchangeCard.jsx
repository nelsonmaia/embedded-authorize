/**
 * One call: the request you send, and the response you got. Side by side, nothing collapsed.
 *
 * When the call is pending the request pane is a live editor — you can type in it immediately.
 * Once sent, it freezes into the coloured read-only view and stays on screen, so the page becomes
 * the transcript of the whole flow.
 */
import { useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, HelpCircle, RotateCcw, Send, Ticket, XCircle } from 'lucide-react';
import { ticketFor, createIssueUrl } from '@/data/jiraTicket.js';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { JsonEditor, JsonView } from './JsonCode.jsx';
import { cn } from '@/lib/utils';

const TONE = {
  200: { variant: 'ok', label: 'success' },
  403: { variant: 'warn', label: 'more steps needed' },
  400: { variant: 'destructive', label: 'rejected' },
  401: { variant: 'destructive', label: 'rejected' },
  429: { variant: 'destructive', label: 'rate limited' },
  500: { variant: 'destructive', label: 'server error' },
  501: { variant: 'secondary', label: 'not implemented' },
};

function curlFor(domain, method, path, body) {
  const host = domain || 'YOUR_TENANT.auth0.com';
  const json = JSON.stringify(body, null, 2).replace(/'/g, "'\\''");
  return `curl -sS -X ${method} 'https://${host}${path}' \\\n  -H 'content-type: application/json' \\\n  -d '${json}'`;
}

/** Three severities, and the difference is what a reader should do about it. */
const FINDING_TONE = {
  violation: {
    label: 'Off spec',
    Icon: XCircle,
    fg: 'text-destructive',
    bg: 'bg-destructive/5',
  },
  gap: {
    label: 'Known gap',
    Icon: AlertTriangle,
    fg: 'text-[hsl(var(--warn))]',
    bg: 'bg-[hsl(var(--warn))]/5',
  },
  undocumented: {
    label: 'Undocumented',
    Icon: HelpCircle,
    fg: 'text-muted-foreground',
    bg: 'bg-muted/30',
  },
};

/**
 * One badge summarising this exchange against the contract.
 *
 * `findings` is only ever set by the live transport — spec mode IS the contract, so a checker over
 * it would do nothing but agree. Absent findings therefore means "not checked", which is why this
 * returns nothing rather than claiming a match.
 */
function verdictFor(result) {
  if (!result?.findings) return null;
  if (result.findings.length === 0) {
    return {
      variant: 'ok',
      label: 'matches the spec',
      border: 'border-[hsl(var(--ok))]/35',
      head: 'bg-[hsl(var(--ok))]/10',
    };
  }

  const worst = result.findings.some((f) => f.severity === 'violation')
    ? 'violation'
    : result.findings.some((f) => f.severity === 'gap')
      ? 'gap'
      : 'undocumented';
  const n = result.findings.length;
  const noun = n === 1 ? 'difference' : 'differences';

  return {
    violation: {
      variant: 'destructive',
      label: `${n} off spec`,
      border: 'border-destructive/40',
      head: 'bg-destructive/10',
    },
    gap: {
      variant: 'warn',
      label: `${n} known ${n === 1 ? 'gap' : 'gaps'}`,
      border: 'border-[hsl(var(--warn))]/40',
      head: 'bg-[hsl(var(--warn))]/10',
    },
    undocumented: {
      variant: 'secondary',
      label: `${n} ${noun}`,
      border: 'border-muted-foreground/30',
      head: 'bg-muted/60',
    },
  }[worst];
}

/**
 * File a finding as a Jira issue, degrading by what is configured.
 *
 *   token set        → POST /__jira, the issue is created and linked
 *   site + id only   → a prefilled create-issue tab, so a human presses Create
 *   nothing set      → the ticket goes to the clipboard
 *
 * The credential never reaches this component: the dev server holds it and only tells us whether
 * it can create. See scripts/vite-plugin-jira.js.
 */
function RaiseButton({ finding, exchange, tenant, jira }) {
  const [state, setState] = useState({ status: 'idle' });

  const raise = async () => {
    const ticket = ticketFor({
      finding,
      exchange,
      tenant,
      observedOn: new Date().toISOString().slice(0, 10),
    });
    if (!ticket) return;

    // The full text always goes to the clipboard: the URL path truncates it, and a failed API
    // call should never lose what you were about to file.
    try {
      await navigator.clipboard.writeText(`${ticket.summary}\n\n${ticket.description}`);
    } catch { /* insecure context — the other paths still work */ }

    if (jira?.canCreate) {
      setState({ status: 'filing' });
      try {
        const res = await fetch('/__jira', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ticket),
        }).then((r) => r.json());
        setState(res.ok ? { status: 'filed', ...res } : { status: 'failed', detail: res.detail });
      } catch (e) {
        setState({ status: 'failed', detail: e.message });
      }
      return;
    }

    const url = createIssueUrl({
      site: jira?.site,
      projectId: jira?.projectId,
      issueTypeId: jira?.issueTypeId,
      ticket,
    });
    if (url) {
      window.open(url, '_blank', 'noopener');
      setState({ status: 'opened' });
    } else {
      setState({ status: 'copied' });
    }
    setTimeout(() => setState({ status: 'idle' }), 2500);
  };

  if (state.status === 'filed') {
    return (
      <a
        href={state.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 self-start rounded border border-[hsl(var(--ok))]/40 bg-[hsl(var(--ok))]/10 px-2 py-1 text-[11px] font-medium text-[hsl(var(--ok))]"
      >
        <ExternalLink className="h-3 w-3" /> {state.key}
      </a>
    );
  }

  const label = {
    idle: jira?.canCreate ? 'Raise in Jira' : jira?.projectId ? 'Raise in Jira' : 'Copy as ticket',
    filing: 'Filing…',
    opened: 'Opened in Jira',
    copied: 'Copied',
    failed: 'Failed — copied',
  }[state.status];

  return (
    <button
      type="button"
      onClick={raise}
      disabled={state.status === 'filing'}
      title={state.detail || 'File this finding as a Jira issue'}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 self-start rounded border px-2 py-1 text-[11px] font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        state.status === 'failed'
          ? 'border-destructive/40 text-destructive'
          : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      )}
    >
      <Ticket className="h-3 w-3" /> {label}
    </button>
  );
}

function PaneHead({ children, className }) {
  return (
    <div
      className={cn(
        'flex h-9 items-center gap-2 border-b px-4 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  );
}

export function ExchangeCard({
  index,
  title,
  hint,
  path = '/e/authorize',
  draftText,
  onDraftChange,
  parseError,
  result,
  edited,
  busy,
  domain,
  jira,
  onSend,
  onReset,
}) {
  const pending = !result;
  const [copied, setCopied] = useState(false);
  const tone = result ? TONE[result.status] || { variant: 'secondary', label: '' } : null;
  const verdict = verdictFor(result);

  const copy = async () => {
    const body = pending ? safeParse(draftText) : result.request.body;
    try {
      await navigator.clipboard.writeText(curlFor(domain, 'POST', path, body));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* insecure context — clipboard unavailable */ }
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-card',
        pending && 'ring-1 ring-primary',
        verdict?.border
      )}
    >
      <div className={cn('flex items-center gap-3 border-b px-4 py-2.5', verdict?.head ?? 'bg-muted/40')}>
        <span
          className={cn(
            'grid h-5 w-5 shrink-0 place-items-center rounded-full font-mono text-[10px] font-bold',
            pending ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'
          )}
        >
          {index + 1}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        {edited && <Badge variant="warn">edited</Badge>}
        {/* Live only: the verdict sits on the exchange it judges, not in a summary elsewhere. */}
        {verdict && (
          <Badge variant={verdict.variant} className="shrink-0 font-normal">
            {verdict.label}
          </Badge>
        )}
      </div>

      <div className="grid lg:grid-cols-2">
        <div className="min-w-0 border-b lg:border-b-0 lg:border-r">
          <PaneHead>
            <span className="font-mono text-[hsl(var(--ok))]">POST</span>
            <span className="font-mono normal-case tracking-normal">{path}</span>
            <span className="flex-1" />
            {pending && <span className="normal-case tracking-normal text-primary">editable</span>}
          </PaneHead>
          {pending ? (
            <JsonEditor text={draftText} onChange={onDraftChange} invalid={!!parseError} />
          ) : (
            <JsonView value={result.request.body} />
          )}
          {pending && parseError && (
            <div className="border-t border-destructive/30 bg-destructive/10 px-4 py-2 font-mono text-xs text-destructive">
              {parseError}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <PaneHead>
            {result ? (
              <>
                <span className="font-mono text-foreground">{result.status || '—'}</span>
                <Badge variant={tone.variant} className="font-normal normal-case tracking-normal">
                  {tone.label}
                </Badge>
                <span className="flex-1" />
                {result.durationMs != null && (
                  <span className="font-mono normal-case tracking-normal">{result.durationMs}ms</span>
                )}
              </>
            ) : (
              <span>response</span>
            )}
          </PaneHead>
          {result ? (
            result.error ? (
              <div className="px-4 py-4 text-sm leading-relaxed text-destructive">{result.error}</div>
            ) : (
              <JsonView value={result.body} />
            )
          ) : (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              Send to see the response.
            </div>
          )}
        </div>
      </div>

      {/* Live only: where this tenant's answer differs from the contract. Annotation beside the
          response, never a change to it — the body above is exactly what came back. */}
      {result?.findings?.length > 0 && (
        <div className="border-t">
          {result.findings.map((f, i) => {
            const tone = FINDING_TONE[f.severity] ?? FINDING_TONE.undocumented;
            const Icon = tone.Icon;
            return (
              <div
                key={i}
                data-finding={f.severity}
                className={cn('flex gap-2.5 border-b px-4 py-3 text-xs leading-relaxed last:border-b-0', tone.bg)}
              >
                <Icon className={cn('mt-px h-3.5 w-3.5 shrink-0', tone.fg)} title={tone.label} />
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{f.title}</span>
                  {/* The difference itself, before any prose about it. */}
                  {(f.expected || f.actual) && (
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                      {f.expected && (
                        <>
                          <dt className="text-[10px] uppercase tracking-widest text-muted-foreground/70">
                            Expected
                          </dt>
                          <dd className="min-w-0 break-words font-mono text-[11px] text-foreground">
                            {f.expected}
                          </dd>
                        </>
                      )}
                      {f.actual && (
                        <>
                          <dt className={cn('text-[10px] uppercase tracking-widest', tone.fg)}>Got</dt>
                          <dd className={cn('min-w-0 break-words font-mono text-[11px]', tone.fg)}>
                            {f.actual}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                  <p className="mt-1.5 text-muted-foreground">{f.why}</p>
                </div>
                <RaiseButton finding={f} exchange={result} tenant={domain} jira={jira} />
              </div>
            );
          })}
        </div>
      )}

      {result?.note && (
        <div className="whitespace-pre-line border-t bg-muted/30 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
          {result.note}
        </div>
      )}

      {result?.gap && (
        <div className="border-t border-destructive/25 bg-destructive/10 px-4 py-2.5 text-xs leading-relaxed text-destructive">
          <span className="font-semibold">Known gap</span> — {result.gap}
        </div>
      )}

      {pending && (
        <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
          <Button size="sm" onClick={onSend} disabled={busy || !!parseError}>
            <Send /> {busy ? 'Sending…' : 'Send'}
          </Button>
          {onReset && (
            <Button size="sm" variant="ghost" onClick={onReset}>
              <RotateCcw /> Reset payload
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={copy}>
            {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'curl'}
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">
            {parseError ? 'Fix the JSON to send.' : hint || 'Type in the request to change it.'}
          </span>
        </div>
      )}
    </div>
  );
}

function safeParse(t) {
  try {
    return JSON.parse(t);
  } catch {
    return {};
  }
}
