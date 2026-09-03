/**
 * The Jira connection, as the console sees it.
 *
 * The credential is not here and never will be. The dev server holds the token and this hook only
 * ever learns whether a connection exists, who it belongs to, and what that person can file
 * against. See scripts/vite-plugin-jira.js for why that boundary is where it is.
 *
 * Where the site, project and issue type live is a deliberate choice: in the tab, not on the
 * server. They are a preference, not state the protocol cares about, and a dev server that
 * remembered them would have to decide whose they were.
 */
import { useCallback, useEffect, useState } from 'react';

const SELECTION_KEY = 'embedded-authorize:jira-selection';

const EMPTY = { cloudId: '', siteUrl: '', projectKey: '', projectId: '', issueTypeName: '' };

const load = () => {
  try {
    return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(SELECTION_KEY) || '{}') };
  } catch {
    return { ...EMPTY };
  }
};

const getJson = (url) => fetch(url).then((r) => r.json());

export function useJira({ enabled = true } = {}) {
  const [status, setStatus] = useState(null); // null until the dev server answers
  const [selection, setSelectionState] = useState(load);
  const [sites, setSites] = useState([]);
  const [projects, setProjects] = useState([]);
  const [issueTypes, setIssueTypes] = useState([]);
  const [error, setError] = useState(null);

  const setSelection = useCallback((patch) => {
    setSelectionState((prev) => {
      const next = { ...prev, ...patch };
      try {
        sessionStorage.setItem(SELECTION_KEY, JSON.stringify(next));
      } catch { /* private mode — the selection just does not survive a reload */ }
      return next;
    });
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) return;
    getJson('/__jira')
      .then(setStatus)
      .catch(() => setStatus({ connected: false, unavailable: true })); // no dev server, or no plugin
  }, [enabled]);

  useEffect(refresh, [refresh]);

  /* Each list depends on the choice above it, so a changed site invalidates the project list and a
     changed project invalidates the issue types. Doing that here rather than in the component keeps
     a stale project key from being filed against the wrong site. */

  useEffect(() => {
    if (!status?.connected) return setSites([]);
    let alive = true;
    getJson('/__jira/sites')
      .then((r) => alive && (r.ok ? setSites(r.sites) : setError(r.detail)))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [status?.connected]);

  // With exactly one site there is no choice to present, so make it.
  useEffect(() => {
    if (sites.length === 1 && !selection.cloudId) {
      setSelection({ cloudId: sites[0].cloudId, siteUrl: sites[0].url });
    }
  }, [sites, selection.cloudId, setSelection]);

  useEffect(() => {
    if (!status?.connected || !selection.cloudId) return setProjects([]);
    let alive = true;
    getJson(`/__jira/projects?cloudId=${encodeURIComponent(selection.cloudId)}`)
      .then((r) => alive && (r.ok ? setProjects(r.projects) : setError(r.detail)))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [status?.connected, selection.cloudId]);

  useEffect(() => {
    if (!status?.connected || !selection.cloudId || !selection.projectKey) return setIssueTypes([]);
    let alive = true;
    const q = `cloudId=${encodeURIComponent(selection.cloudId)}&projectKey=${encodeURIComponent(selection.projectKey)}`;
    getJson(`/__jira/issuetypes?${q}`)
      .then((r) => alive && (r.ok ? setIssueTypes(r.issueTypes) : setError(r.detail)))
      .catch((e) => alive && setError(e.message));
    return () => { alive = false; };
  }, [status?.connected, selection.cloudId, selection.projectKey]);

  // Default to Bug where the project has one: a conformance finding is a bug report.
  useEffect(() => {
    if (!issueTypes.length || selection.issueTypeName) return;
    const preferred = issueTypes.find((t) => /^bug$/i.test(t.name)) ?? issueTypes[0];
    setSelection({ issueTypeName: preferred.name });
  }, [issueTypes, selection.issueTypeName, setSelection]);

  const disconnect = useCallback(async () => {
    await fetch('/__jira/disconnect', { method: 'POST' }).catch(() => {});
    setSelectionState({ ...EMPTY });
    try { sessionStorage.removeItem(SELECTION_KEY); } catch { /* ignore */ }
    refresh();
  }, [refresh]);

  const file = useCallback(
    (ticket) =>
      fetch('/__jira/issue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...ticket, ...selection }),
      }).then((r) => r.json()),
    [selection]
  );

  return {
    status,
    connected: !!status?.connected,
    /* A connection alone is not enough to file: without a project the call would be rejected by
       Jira rather than by us, which is a worse place to find out. */
    canCreate: !!(status?.connected && selection.cloudId && selection.projectKey),
    user: status?.user ?? null,
    selection,
    setSelection,
    sites,
    projects,
    issueTypes,
    error,
    refresh,
    disconnect,
    file,
  };
}
