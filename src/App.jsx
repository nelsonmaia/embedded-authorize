/**
 * Two things you can be doing, and they are independent:
 *
 *   End state   — what the protocol does once it is finished. Nothing leaves the browser.
 *   Live tenant — what a real tenant does today.
 *
 * Neither falls back to the other: a failing live call is shown failing, because a spec-shaped
 * answer would mean you were no longer testing your tenant.
 */
import { useEffect, useMemo, useState } from 'react';
import { FlaskConical, Radio } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { ConsoleView } from '@/views/ConsoleView.jsx';
import { ContractView } from '@/views/ContractView.jsx';
import { DEFAULT_FLOW_ID, flowById } from '@/data/flows.js';

const TENANT_KEY = 'eplay-tenant-v2';

function loadTenant() {
  try {
    const v = JSON.parse(sessionStorage.getItem(TENANT_KEY) || '{}');
    return {
      domain: v.domain || '',
      clientId: v.clientId || '',
      connection: v.connection || 'Username-Password-Authentication',
      audience: v.audience || '',
      scope: v.scope || 'openid profile email',
    };
  } catch {
    return {
      domain: '',
      clientId: '',
      connection: 'Username-Password-Authentication',
      audience: '',
      scope: 'openid profile email',
    };
  }
}

export default function App() {
  const [mode, setMode] = useState('spec');
  const [view, setView] = useState('console');
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

        <Tabs value={mode} onValueChange={setMode}>
          <TabsList>
            <TabsTrigger value="spec">
              <FlaskConical /> End state
            </TabsTrigger>
            <TabsTrigger value="live">
              <Radio /> Live tenant
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <Button
          variant={view === 'contract' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => setView(view === 'contract' ? 'console' : 'contract')}
        >
          {view === 'contract' ? 'Back to console' : 'Full contract'}
        </Button>
      </header>

      <div className="border-b bg-muted/20 px-6 py-2 text-xs text-muted-foreground">
        {mode === 'spec'
          ? 'How each flow will behave once it is fully built. Simulated locally — nothing leaves your browser.'
          : 'What your tenant does right now. Real calls, real responses — including where it is not finished yet.'}
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
