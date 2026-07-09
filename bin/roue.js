#!/usr/bin/env node
// Point d'entrée CLI — délègue au build TypeScript (dist/cli.js).
import('../dist/cli.js').catch((err) => {
  console.error('roue : impossible de charger dist/cli.js — lance `npm run build:server` d\'abord.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
