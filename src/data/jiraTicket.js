/**
 * Turn one conformance finding into a Jira issue.
 *
 * A pure function, so the ticket body can be tested without a Jira. The same text is used whether
 * the issue is filed through the API or prefilled into a create-issue URL — a ticket that reads
 * differently depending on how it was raised would be worse than either.
 *
 * The body is plain text with wiki-ish headings rather than ADF (Atlassian Document Format).
 * `/rest/api/2/issue` accepts a string description and Jira Cloud still serves it; ADF would mean
 * building a document tree to say the same thing, and would make the deep-link path impossible
 * since a URL parameter can only carry text.
 */

const MAX_JSON = 1500;

/** Long payloads are truncated: a session token is 3 KB of base64 nobody reads in a ticket. */
const short = (value) => {
  const text = JSON.stringify(value, null, 2);
  if (!text || text.length <= MAX_JSON) return text;
  return `${text.slice(0, MAX_JSON)}\n… truncated, ${text.length - MAX_JSON} more characters`;
};

const SEVERITY_LABEL = {
  violation: 'off-spec',
  gap: 'known-gap',
  undocumented: 'undocumented',
};

/**
 * @param {{
 *   finding: { severity: string, title: string, expected?: string, actual?: string, why: string, gap?: string },
 *   exchange?: { request?: { method?: string, path?: string, body?: object }, status?: number, body?: object },
 *   tenant?: string,
 *   observedOn?: string,
 * }} input
 */
export function ticketFor({ finding, exchange, tenant, observedOn } = {}) {
  if (!finding?.title) return null;

  const lines = [];

  lines.push('h3. What differs');
  lines.push('');
  if (finding.expected) lines.push(`*Expected:* ${finding.expected}`);
  if (finding.actual) lines.push(`*Got:* ${finding.actual}`);
  lines.push('');
  lines.push('h3. Why it matters');
  lines.push('');
  lines.push(finding.why);

  if (finding.gap) {
    lines.push('');
    lines.push('h3. Already recorded');
    lines.push('');
    lines.push(
      `This is a known deviation, tracked in the console as "${finding.gap}". Raising it here to ` +
        'put it on a board, not because it is news.'
    );
  }

  lines.push('');
  lines.push('h3. Where it was seen');
  lines.push('');
  if (tenant) lines.push(`*Tenant:* ${tenant}`);
  if (observedOn) lines.push(`*Observed:* ${observedOn}`);

  if (exchange) {
    const { request, status, body } = exchange;
    lines.push('');
    lines.push('h3. The exchange');
    lines.push('');
    lines.push(`{code:json}`);
    lines.push(`${request?.method ?? 'POST'} ${request?.path ?? '/e/authorize'}`);
    lines.push(short(request?.body ?? {}));
    lines.push('');
    lines.push(`HTTP ${status}`);
    lines.push(short(body ?? {}));
    lines.push('{code}');
  }

  lines.push('');
  lines.push('----');
  lines.push(
    'Raised from the Embedded Authorize console, which checks every live response against the ' +
      'contract in {{src/data/spec.js}}. The request body above is verbatim; secrets are masked ' +
      'before they reach the screen.'
  );

  return {
    summary: finding.title,
    description: lines.join('\n'),
    labels: ['embedded-authorize', 'spec-conformance', SEVERITY_LABEL[finding.severity] ?? 'finding'],
  };
}

/**
 * A prefilled create-issue URL, for when no API credential is configured.
 *
 * Needs the NUMERIC project id: `CreateIssueDetails!init.jspa` will not resolve a project key.
 * Returns null without one rather than opening a page that silently ignores the prefill.
 *
 * Jira caps the query string, so the description is trimmed — the caller should put the full text
 * on the clipboard at the same time.
 */
const MAX_URL_DESCRIPTION = 1200;

export function createIssueUrl({ site, projectId, issueTypeId, ticket } = {}) {
  if (!site || !projectId || !ticket) return null;

  const params = new URLSearchParams({ pid: String(projectId), summary: ticket.summary });
  if (issueTypeId) params.set('issuetype', String(issueTypeId));

  const description =
    ticket.description.length > MAX_URL_DESCRIPTION
      ? `${ticket.description.slice(0, MAX_URL_DESCRIPTION)}\n\n… trimmed to fit the URL; the full text is on your clipboard.`
      : ticket.description;
  params.set('description', description);

  const host = site.includes('.') ? site : `${site}.atlassian.net`;
  return `https://${host}/secure/CreateIssueDetails!init.jspa?${params}`;
}
