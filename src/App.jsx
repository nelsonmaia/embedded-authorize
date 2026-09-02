/**
 * Three places you can be, and only one at a time:
 *
 *   End state     — what the protocol does once it is finished. Nothing leaves the browser.
 *   Live tenant   — what a real tenant does today.
 *   API Spec      — what each call takes and returns, with nothing running.
 *
 * The first two never fall back to each other: a failing live call is shown failing, because a
 * spec-shaped answer would mean you were no longer testing your tenant.
 */
import { useEffect, useMemo, useState } from 'react';
import { BookText, FlaskConical, Radio } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ThemeToggle } from '@/components/ThemeToggle.jsx';
import { ConsoleView } from '@/views/ConsoleView.jsx';
import { ContractView } from '@/views/ContractView.jsx';
import { DEFAULT_FLOW_ID, flowById } from '@/data/flows.js';

const TENANT_KEY = 'eplay-tenant-v2';

/**
 * The tenant the live-mode findings in this repo were recorded against, prefilled so live mode is
 * one click rather than a hunt through the dashboard. The client_id is safe to ship: /e/authorize
 * serves public clients, which by definition hold no secret.
 */
const DEFAULT_TENANT = {
  domain: 'nelson.jp.auth0.com',
  clientId: 'yQjhZg0l3xGZTfDdCMYIdqQVEs0i020m',
  connection: 'Username-Password-Authentication',
  audience: '',
  scope: 'openid profile email',
};

function loadTenant() {
  try {
    const v = JSON.parse(sessionStorage.getItem(TENANT_KEY) || '{}');
    return {
      domain: v.domain || DEFAULT_TENANT.domain,
      clientId: v.clientId || DEFAULT_TENANT.clientId,
      connection: v.connection || DEFAULT_TENANT.connection,
      audience: v.audience || DEFAULT_TENANT.audience,
      scope: v.scope || DEFAULT_TENANT.scope,
    };
  } catch {
    return { ...DEFAULT_TENANT };
  }
}

export default function App() {
  /**
   * One control, three destinations.
   *
   * Mode (spec/live) and view (console/contract) used to be separate widgets, which meant the
   * mode tabs stayed lit while you were reading the contract — highlighting a choice that had no
   * effect on what was on screen. They are mutually exclusive places to be, so they are one tab
   * strip: exactly one thing is ever highlighted, and it is where you are.
   */
  const [nav, setNav] = useState('spec');
  const view = nav === 'contract' ? 'contract' : 'console';
  const mode = nav === 'live' ? 'live' : 'spec';

  const [flowId, setFlowId] = useState(DEFAULT_FLOW_ID);
  const [variantId, setVariantId] = useState(null);
  const [tenant, setTenant] = useState(loadTenant);

  const flow = useMemo(() => flowById(flowId), [flowId]);

  useEffect(() => {
    try {
      sessionStorage.setItem(TENANT_KEY, JSON.stringify(tenant));
    } catch { /* private browsing — not worth failing over */ }
  }, [tenant]);

  const changeFlow = (id) => {
    setFlowId(id);
    setVariantId(flowById(id)?.variants[0]?.id ?? null);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-6 py-3">
        <div className="text-sm font-semibold tracking-tight">
          Embedded Authorize
          <span className="ml-2.5 font-mono text-xs font-normal text-muted-foreground">
            POST /e/authorize
          </span>
        </div>

        <div className="flex-1" />

        <Tabs value={nav} onValueChange={setNav}>
          <TabsList>
            <TabsTrigger value="spec">
              <FlaskConical /> End state
            </TabsTrigger>
            <TabsTrigger value="live">
              <Radio /> Live tenant
            </TabsTrigger>
            <TabsTrigger value="contract">
              <BookText /> API Spec
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <ThemeToggle />
      </header>

      <div className="border-b bg-muted/20 px-6 py-2 text-xs text-muted-foreground">
        {nav === 'spec' &&
          'How each flow will behave once it is fully built. Simulated locally — nothing leaves your browser.'}
        {nav === 'live' &&
          'What your tenant does right now. Real calls, real responses — including where it is not finished yet.'}
        {nav === 'contract' &&
          'The specification for POST /e/authorize: every parameter, every action, every response. Nothing runs here.'}
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {view === 'contract' ? (
          <ContractView />
        ) : (
          <ConsoleView
            mode={mode}
            flowId={flowId}
            variantId={variantId ?? flow?.variants[0]?.id}
            onFlowChange={changeFlow}
            onVariantChange={setVariantId}
            tenant={tenant}
            onTenantChange={setTenant}
          />
        )}
      </main>
    </div>
  );
}
