/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  // used only by the end-to-end test stack (e2e/stack.sh): same-origin proxy to GoTrue / PostgREST
  preview: process.env.PM_E2E ? {
    proxy: {
      '/auth/v1': { target: 'http://127.0.0.1:9999', changeOrigin: true, rewrite: (p) => p.replace(/^\/auth\/v1/, '') },
      '/rest/v1': { target: 'http://127.0.0.1:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/rest\/v1/, '') },
    },
  } : undefined,
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: { manualChunks: { supabase: ['@supabase/supabase-js'] } },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
