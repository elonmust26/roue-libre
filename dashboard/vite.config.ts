import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Root implicite = dossier dashboard (via `vite build dashboard`).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      // En dev, l'API et le WS sont servis par le serveur roue-libre (port 4700 par défaut).
      '/api': 'http://localhost:4700',
      '/ws': {
        target: 'ws://localhost:4700',
        ws: true,
      },
    },
  },
});
