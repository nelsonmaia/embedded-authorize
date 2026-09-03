/**
 * vite-plugin-jira.js — the Vite binding for the Jira connection.
 *
 * The handler itself lives in ./jira-mcp/handler.js, shared with the deployed server so the two
 * cannot drift. Tokens are held per browser session, which is what makes mounting it in a
 * deployment safe: see ./jira-mcp/sessions.js.
 */

import { handleJira } from './jira-mcp/handler.js';

export function jiraIssues() {
  return {
    name: 'jira-issues',
    apply: 'serve',

    configureServer(server) {
      server.middlewares.use('/__jira', async (req, res, next) => {
        const handled = await handleJira(req, res);
        if (!handled) next();
      });
    },
  };
}
