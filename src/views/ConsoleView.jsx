/**
 * The console. A transcript of calls, each with an editable request and its response.
 *
 * The draft is held as *text*, not as a parsed object, so what you typed is never reformatted or
 * lost while it is briefly invalid. It is parsed on send.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleSlash, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ExchangeCard } from '@/components/ExchangeCard.jsx';
import { BrowserLeg } from '@/components/BrowserLeg.jsx';
import { NextBar } from '@/components/NextBar.jsx';
import { TenantBar } from '@/components/TenantBar.jsx';
import { JiraBar } from '@/components/JiraBar.jsx';
import { FlowPicker } from '@/components/FlowPicker.jsx';
import { cannedTransport } from '@/transports/cannedTransport.js';
import { simulatorTransport, initiateSeed } from '@/transports/simulatorTransport.js';
import { liveTransport } from '@/transports/liveTransport.js';
import { flowById } from '@/data/flows.js';
import { LIVE_CAPABILITIES } from '@/data/spec.js';
import { useJira } from '@/hooks/useJira.js';
import { probeServer } from '@/data/serverProbe.js';

const pretty = (o) => JSON.stringify(o, null, 2);

export function ConsoleView({ mode, flowId, variantId, onFlowChange, onVariantChange, tenant, onTenantChange }) {
  const flow = useMemo(() => flowById(flowId), [flowId]);
  const variant = useMemo(
    () => flow?.variants.find((v) => v.id === variantId) ?? flow?.variants[0] ?? null,
    [flow, variantId]
  );

  const [sent, setSent] = useState([]);
  const [draft, setDraft] = useState('');
  const [pendingTitle, setPendingTitle] = useState('');
  const [awaitingChoice, setAwaitingChoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outOfOrder, setOutOfOrder] = useState(false);
  const [nonce, setNonce] = useState(0);
  /* The Jira connection, only asked for in live mode — spec mode has no tenant to find a gap in.
     Null until the dev server answers, which is why the button does not flicker between labels. */
  const jira = useJira({ enabled: mode === 'live' });

  /* Whether a server is behind this page at all. Asked on entering live mode rather than after a
     failed Send, because "why did nothing happen" is a worse first experience than being told the
     one thing that has to be true before anything can work. */
  const [server, setServer] = useState(null);
  useEffect(() => {
    if (mode !== 'live') return setServer(null);
    let alive = true;
    probeServer().then((p) => alive && setServer(p));
    return () => { alive = false; };
  }, [mode]);

  const transport = useRef(null);
  const seedRef = useRef(''); // the untouched suggestion, for "Reset payload"

  const key =
    mode === 'live'
      ? `live:${tenant.domain}:${tenant.clientId}:${tenant.connection}:${nonce}`
      : `${flowId}:${variant?.id ?? ''}:${nonce}`;

  useEffect(() => {
    let t = null;
    let seed = {};

    if (mode === 'live') {
      t = liveTransport({ tenant, capabilities: LIVE_CAPABILITIES });
      seed = {
        client_id: tenant.clientId || '',
        connection: tenant.connection || '',
        capabilities: [...LIVE_CAPABILITIES],
      };
      if (tenant.audience) seed.audience = tenant.audience;
      if (tenant.scope) seed.scope = tenant.scope;
    } else if (flow?.kind === 'signup' && variant) {
      t = cannedTransport({ scenario: flow.scenario, happyPath: variant.happyPath });
      seed = t.seedFor();
    } else if (flow?.kind === 'login') {
      t = simulatorTransport({ scenario: flow.scenario });
      seed = initiateSeed(flow.scenario);
    }

    transport.current = t;
    seedRef.current = pretty(seed);
    setSent([]);
    setDraft(pretty(seed));
    setPendingTitle(variant?.happyPath.exchanges[0]?.label ?? 'Start the session');
    setAwaitingChoice(false);
    setOutOfOrder(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const parseError = useMemo(() => {
    if (!draft.trim()) return 'Request body is empty.';
    try {
      const v = JSON.parse(draft);
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'Expected a JSON object.';
      return null;
    } catch (e) {
      return e.message;
    }
  }, [draft]);

  const last = sent.at(-1)?.result ?? null;
  const next = Array.isArray(last?.body?.next) ? last.body.next : [];
  const done = !!last && (!!last.body?.authorization_code || last.body?.error === 'access_denied');
  const labelAt = (i) => variant?.happyPath.exchanges[i]?.label ?? null;

  const send = useCallback(async () => {
    const t = transport.current;
    if (!t || parseError) return;
    const body = JSON.parse(draft);

    setBusy(true);
    try {
      const result = sent.length === 0 ? await t.start(body) : await t.send(body);
      const wasEdited = pretty(body) !== seedRef.current;

      setSent((prev) => [...prev, { result, edited: wasEdited, title: pendingTitle }]);
      setOutOfOrder(false);

      if (result.undocumented) {
        setAwaitingChoice(false);
        setDraft('');
        return;
      }

      const nx = Array.isArray(result.body?.next) ? result.body.next : [];
      if (nx.length === 0) {
        setDraft('');
        setAwaitingChoice(false);
        return;
      }

      /* One option, or a recording that knows exactly what comes next → prefill it. Genuinely
         several options → make the user choose from next[] rather than choosing for them. */
      if (t.kind === 'canned' || nx.length === 1) {
        const seed = t.seedFor(nx[0]);
        seedRef.current = pretty(seed);
        setDraft(pretty(seed));
        setPendingTitle(labelAt(sent.length + 1) ?? 'Next call');
        setAwaitingChoice(false);
      } else {
        setDraft('');
        setAwaitingChoice(true);
      }
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, parseError, sent.length, pendingTitle, variant]);

  const pick = (entry) => {
    const seed = transport.current.seedFor(entry);
    seedRef.current = pretty(seed);
    setDraft(pretty(seed));
    setPendingTitle(labelAt(sent.length) ?? entry.action.replace(/^action:/, '').replace(/:v1$/, ''));
    setAwaitingChoice(false);
    setOutOfOrder(false);
  };

  const tryOutOfOrder = () => {
    const t = transport.current;
    const action = flow?.kind === 'signup' ? 'action:signup:confirm:v1' : 'action:verify:otp:v1';
    const seed = { ...t.seedFor({ action }), action };
    seedRef.current = pretty(seed);
    setDraft(pretty(seed));
    setPendingTitle('A call the server did not offer');
    setAwaitingChoice(false);
    setOutOfOrder(true);
  };

  const restart = () => setNonce((n) => n + 1);

  const showPending = draft !== '' && !awaitingChoice;
  const needsTenant = mode === 'live' && (!tenant.domain?.trim() || !tenant.clientId?.trim());

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-6 py-6">
      {mode === 'live' ? (
        <>
          {server && !server.running && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm leading-relaxed">
              <p className="font-medium text-destructive">This page is being served as files, not by its server.</p>
              <p className="mt-1 text-muted-foreground">
                Live mode needs one: <code className="font-mono text-xs">POST /e/authorize</code> sends
                no CORS headers, so the call has to be made server-side.{' '}
                {server.servedBy === 'static' ? (
                  <>
                    <code className="font-mono text-xs">/__health</code> came back as this page's own
                    HTML rather than JSON — the signature of a static host answering everything from{' '}
                    <code className="font-mono text-xs">index.html</code>. The same host will refuse{' '}
                    <code className="font-mono text-xs">POST /__tenant</code> with a 405.
                  </>
                ) : (
                  <>
                    Nothing answered <code className="font-mono text-xs">/__health</code>
                    {server.status ? ` (HTTP ${server.status})` : ''}, so{' '}
                    <code className="font-mono text-xs">/__tenant</code> has nothing behind it either.
                  </>
                )}{' '}
                Run <code className="font-mono text-xs">npm run dev</code>, or deploy with{' '}
                <code className="font-mono text-xs">node server.js</code> rather than serving{' '}
                <code className="font-mono text-xs">dist/</code> as files.
              </p>
            </div>
          )}
          <TenantBar tenant={tenant} onChange={onTenantChange} />
          {/* Where findings go. Sits under the tenant fields because it is the same kind of
              setting: something you set once and then stop looking at. */}
          <div className="rounded-lg border border-dashed px-4 py-3">
            <JiraBar jira={jira} />
          </div>
        </>
      ) : (
        <FlowPicker
          flowId={flowId}
          variantId={variant?.id}
          flow={flow}
          onFlowChange={onFlowChange}
          onVariantChange={onVariantChange}
        />
      )}

      {/* What this flow is meant to show, and the rule it turns on. Both were already written on
          every scenario and neither reached the screen. */}
      {mode !== 'live' && flow?.scenario?.summary && (
        <p className="rounded-lg border-l-2 border-primary/50 bg-muted/40 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          {flow.scenario.summary}
        </p>
      )}

      {needsTenant ? (
        <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          Enter a tenant domain and client ID to start testing.
        </p>
      ) : (
        <div className="space-y-3">
          {sent.map((s, i) => (
            <div key={i} className="space-y-3">
              <ExchangeCard
                index={i}
                title={s.title}
                result={s.result}
                edited={s.edited}
                domain={tenant?.domain}
                jira={jira}
              />
              {/* The browser leg sits between the call that handed back an href and the one that
                  resumes — the only step in the transcript that is not a request. */}
              <BrowserLeg handoff={s.result?.handoff} outcome={sent[i + 1]?.result?.legOutcome} />
              {i === sent.length - 1 && !showPending && !done && (
                <NextBar
                  next={next}
                  onPick={pick}
                  onOutOfOrder={tryOutOfOrder}
                  allowOutOfOrder={next.length > 0}
                />
              )}
            </div>
          ))}

          {showPending && (
            <ExchangeCard
              index={sent.length}
              title={pendingTitle}
              draftText={draft}
              onDraftChange={setDraft}
              parseError={parseError}
              busy={busy}
              edited={outOfOrder}
              domain={tenant?.domain}
              onSend={send}
              onReset={draft !== seedRef.current ? () => setDraft(seedRef.current) : null}
              hint={outOfOrder ? 'This action is not in next[] — see what the server does.' : undefined}
            />
          )}

          {done && (
            <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-4 py-4 text-sm">
              {last.body.authorization_code ? (
                <>
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--ok))]" />
                  <p className="text-muted-foreground">
                    Done — an authorization code was issued. Exchange it at{' '}
                    <code className="font-mono text-foreground">POST /oauth/token</code> with the
                    standard <code className="font-mono text-foreground">authorization_code</code>{' '}
                    grant. No new grant type was introduced.
                  </p>
                </>
              ) : (
                <>
                  <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  <p className="text-muted-foreground">
                    The flow ended and the session is gone. A client starts over from the beginning.
                  </p>
                </>
              )}
            </div>
          )}

          {sent.length > 0 && (
            <Button variant="ghost" size="sm" onClick={restart}>
              <RotateCcw /> Start over
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
