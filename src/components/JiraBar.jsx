/**
 * Connect to Jira, and choose where findings get filed.
 *
 * There is nothing to configure before this works — no API token, no project id looked up in an
 * admin screen, no environment variables. Pressing Connect runs an authorization code flow with
 * PKCE S256 against a client the dev server registers for itself, which is the same shape this
 * console argues for at /e/authorize. Tickets are then authored by whoever consented.
 */
import { ExternalLink, Loader2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

function Picker({ label, value, onChange, options, placeholder, disabled }) {
  return (
    <div className="min-w-[150px] flex-1 space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="text-xs">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function JiraBar({ jira }) {
  const { status, connected, user, selection, setSelection, sites, projects, issueTypes, error } = jira;

  // Still asking the dev server. Rendering a Connect button now would flash it away again.
  if (status === null) return null;

  if (status.unavailable) {
    return (
      <p className="text-xs text-muted-foreground">
        Findings can be copied as a ticket. Filing them in Jira needs the dev server.
      </p>
    );
  }

  if (!connected) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        {/* A full navigation, not fetch: the consent screen is Atlassian's page and has to own the
            window. It comes back to /__jira/callback, which returns here. */}
        <Button size="sm" variant="outline" onClick={() => { window.location.href = '/__jira/connect'; }}>
          <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Connect to Jira
        </Button>
        <p className="text-xs text-muted-foreground">
          Authorization code + PKCE, scoped to reading and writing Jira work. No API token, and
          nothing to configure — the token stays in the dev server and tickets are filed as you.
        </p>
        {error && <p className="text-xs text-[hsl(var(--bad))]">{error}</p>}
      </div>
    );
  }

  const name = user?.name ?? user?.displayName ?? user?.email ?? 'your account';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        {sites.length > 1 && (
          <Picker
            label="Site"
            value={selection.cloudId}
            placeholder="Choose a site"
            options={sites.map((s) => ({ value: s.cloudId, label: s.name }))}
            onChange={(cloudId) =>
              setSelection({
                cloudId,
                siteUrl: sites.find((s) => s.cloudId === cloudId)?.url ?? '',
                projectKey: '', // a project key means nothing on a different site
                projectId: '',
                issueTypeName: '',
              })
            }
          />
        )}

        <Picker
          label="Project"
          value={selection.projectKey}
          placeholder={selection.cloudId ? 'Choose a project' : 'Choose a site first'}
          disabled={!selection.cloudId}
          options={projects.map((p) => ({ value: p.key, label: `${p.key} — ${p.name}` }))}
          onChange={(projectKey) =>
            setSelection({
              projectKey,
              // Kept for the fallback link: a prefilled create-issue URL cannot resolve a key.
              projectId: projects.find((p) => p.key === projectKey)?.id ?? '',
              issueTypeName: '',
            })
          }
        />

        <Picker
          label="Issue type"
          value={selection.issueTypeName}
          placeholder={selection.projectKey ? 'Choose a type' : 'Choose a project first'}
          disabled={!selection.projectKey}
          options={issueTypes.map((t) => ({ value: t.name, label: t.name }))}
          onChange={(issueTypeName) => setSelection({ issueTypeName })}
        />

        <Button size="sm" variant="ghost" onClick={jira.disconnect} className="text-xs">
          <LogOut className="mr-1.5 h-3.5 w-3.5" /> Disconnect
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        {selection.cloudId && !projects.length ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading projects…
          </span>
        ) : (
          <>
            Connected as {name}. Findings are filed as you, and the connection is revocable from
            your Atlassian account.
          </>
        )}
      </p>
      {error && <p className="text-xs text-[hsl(var(--bad))]">{error}</p>}
    </div>
  );
}
