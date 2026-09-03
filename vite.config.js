import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { tenantProxy } from './scripts/vite-plugin-tenant-proxy.js';
import { jiraIssues } from './scripts/vite-plugin-jira.js';

/* Vite reads .env for client code, but only exposes VITE_-prefixed values and never populates
   process.env. The tenant proxy runs in this process and reads process.env, so load it here too —
   otherwise a documented setting in .env is silently ignored on the dev server alone. */
try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch {
  /* no .env — the environment is expected to carry it */
}

export default defineConfig({
  plugins: [react(), tenantProxy(), jiraIssues()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5177, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
