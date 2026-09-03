import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { tenantProxy } from './scripts/vite-plugin-tenant-proxy.js';
import { jiraIssues } from './scripts/vite-plugin-jira.js';

export default defineConfig({
  plugins: [react(), tenantProxy(), jiraIssues()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5177, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
