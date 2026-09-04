/**
 * Tenant fields for live testing. Inline at the top rather than in a side panel — you set these
 * once and then stop looking at them.
 *
 * There is deliberately no client_secret field: public clients only, and the dev server rejects a
 * payload containing one.
 */
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const FIELDS = [
  ['domain', 'Tenant domain', 'your-tenant.auth0.com', 'flex-[2]'],
  ['clientId', 'Client ID', 'public client', 'flex-[2]'],
  ['connection', 'Connection', 'Username-Password-Authentication', 'flex-[2]'],
  ['audience', 'Audience', 'optional', 'flex-1'],
  ['scope', 'Scope', 'openid profile email', 'flex-1'],
];

export function TenantBar({ tenant, onChange }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        {FIELDS.map(([k, label, ph, grow]) => (
          <div key={k} className={`min-w-[160px] ${grow} space-y-1.5`}>
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <Input
              value={tenant[k] || ''}
              placeholder={ph}
              className="font-mono text-xs"
              onChange={(e) => onChange({ ...tenant, [k]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Kept in this tab only, never saved to disk. Requests are made server-side, so there is no
        CORS problem — the same reason Postman can call this endpoint.
      </p>
    </div>
  );
}
