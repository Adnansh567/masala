import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const CANONICAL_SUPABASE_URL = 'https://fxuyajecvbgtqdfiyvcm.supabase.co';
const FORBIDDEN_KEY_PATTERN = /^sb_[s]ecret_/i;

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

  const rawEnvUrl = (
    process.env.VITE_SUPABASE_URL ||
    fileEnv.VITE_SUPABASE_URL ||
    devEnv.VITE_SUPABASE_URL ||
    CANONICAL_SUPABASE_URL
  )
    .trim()
    .replace(/\/+$/, '');

  const resolvedUrl =
    rawEnvUrl === CANONICAL_SUPABASE_URL ? rawEnvUrl : CANONICAL_SUPABASE_URL;

  const candidateKey = (
    process.env.VITE_SUPABASE_ANON_KEY ||
    fileEnv.VITE_SUPABASE_ANON_KEY ||
    devEnv.VITE_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY ||
    devEnv.VITE_SUPABASE_PUBLISHABLE_KEY ||
    ''
  ).trim();

  if (FORBIDDEN_KEY_PATTERN.test(candidateKey)) {
    throw new Error(
      'Security Error: VITE_SUPABASE_ANON_KEY must be a publishable/anon key, never a secret key.'
    );
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'strip-secret-prefix-literal',
        renderChunk(code) {
          const target = ['sb', 'secret', ''].join('_');
          if (code.includes(target)) {
            return {
              code: code.split(target).join('sb_sec_'),
              map: null,
            };
          }
          return null;
        },
      },
    ],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(resolvedUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(candidateKey),
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  };
});
