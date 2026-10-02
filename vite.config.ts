import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

function loadPlatformDevEnv(): Record<string, string> {
  const candidates = [
    path.resolve(process.cwd(), '../.dev.env.json'),
    '/app/.dev.env.json',
  ];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string') {
            out[k] = v;
          }
        }
        return out;
      }
    } catch {
      // Ignore parse/read errors
    }
  }
  return {};
}

export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const devEnv = loadPlatformDevEnv();

  const resolvedUrl = (
    process.env.VITE_SUPABASE_URL ||
    fileEnv.VITE_SUPABASE_URL ||
    devEnv.VITE_SUPABASE_URL ||
    'https://fxuyajecvbgtqdfiyvcm.supabase.co'
  ).trim();

  const candidateKey = (
    process.env.VITE_SUPABASE_ANON_KEY ||
    fileEnv.VITE_SUPABASE_ANON_KEY ||
    devEnv.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY ||
    devEnv.VITE_SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  // Never expose an sb_secret_... key to client-side code
  const safePublishableKey = candidateKey.startsWith('sb_secret_') ? '' : candidateKey;

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(resolvedUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(safePublishableKey),
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  };
});
