/**
 * One call: the request you send, and the response you got. Side by side, nothing collapsed.
 *
 * When the call is pending the request pane is a live editor — you can type in it immediately.
 * Once sent, it freezes into the coloured read-only view and stays on screen, so the page becomes
 * the transcript of the whole flow.
 */
import { useState } from 'react';
import { Check, Copy, RotateCcw, Send } from 'lucide-react';
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
  onSend,
  onReset,
}) {
  const pending = !result;
  const [copied, setCopied] = useState(false);
  const tone = result ? TONE[result.status] || { variant: 'secondary', label: '' } : null;

  const copy = async () => {
    const body = pending ? safeParse(draftText) : result.request.body;
    try {
      await navigator.clipboard.writeText(curlFor(domain, 'POST', path, body));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* insecure context — clipboard unavailable */ }
  };

  return (
    <div className={cn('overflow-hidden rounded-lg border bg-card', pending && 'ring-1 ring-primary')}>
      <div className="flex items-center gap-3 border-b bg-muted/40 px-4 py-2.5">
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
