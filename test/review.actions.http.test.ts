/**
 * Preuve Phase 1 (niveau HTTP) — les 3 actions de l'écran Revue passent par
 * les routes réelles du serveur, exactement comme les boutons du dashboard :
 *   POST /api/actions/merge  → status.json passe à merged + événement 'merge'
 *   POST /api/actions/return → retour en coding + événement 'return_to_coder'
 *   POST /api/actions/abort  → aborted + événement 'abort'
 * et le WebSocket diffuse bien le nouveau statut (rafraîchissement du dashboard).
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { Orchestrator } from '../src/core/engine.js';
import { startServer } from '../src/server/index.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { DEFAULT_CONFIG, ORCH_DIR } from '../src/core/types.js';
import type { OrchestratorEvent, RoueConfig, ServerHandle, Stage, StatusJson, WsMessage } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attendre<T>(predicat: () => T | undefined, timeoutMs: number, motif: string): Promise<T> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    const valeur = predicat();
    if (valeur !== undefined) return valeur;
    await pause(50);
  }
  throw new Error(`timeout: ${motif}`);
}

function lireStatusJson(repoDir: string): StatusJson {
  return JSON.parse(fs.readFileSync(path.join(repoDir, ORCH_DIR, 'status.json'), 'utf8')) as StatusJson;
}

function lireEvents(repoDir: string): OrchestratorEvent[] {
  return fs
    .readFileSync(path.join(repoDir, ORCH_DIR, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as OrchestratorEvent);
}

/** Monte orchestrateur simulé + serveur HTTP réel, et déroule le cycle jusqu'à review. */
async function monterServeurEnReview() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-http-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const config: RoueConfig = { ...DEFAULT_CONFIG, budget_usd: 5, max_iterations: 3, timeout_minutes: 1 };
  const orchestrateur = new Orchestrator({
    repoDir,
    packageRoot: RACINE_PACKAGE,
    config,
    runner: new SimulatedRunner(),
    gates: new SimulatedGateRunner(),
    git: new SimulatedGitOps({ repoDir }),
  });
  const port = 4600 + Math.floor(Math.random() * 300);
  const poignee = await startServer({ port, orchestrator: orchestrateur });

  await orchestrateur.createTask({
    description: 'démo',
    success_criterion: 'le fichier demo.txt contient OK',
    risk_level: 'low',
  });
  await orchestrateur.confirmTask();
  await attendre(
    () => (orchestrateur.getStatus()?.stage === 'review' ? true : undefined),
    20000,
    `stage review jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`,
  );

  const base = `http://127.0.0.1:${poignee.port}`;
  return { repoDir, orchestrateur, poignee, base };
}

describe('actions de la Revue de diff — routes HTTP réelles (preuve Phase 1)', () => {
  let poignee: ServerHandle | null = null;
  let ws: WebSocket | null = null;

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
    if (poignee) await poignee.close();
    poignee = null;
  });

  it("POST /api/actions/merge en review → 200, status.json = merged, événement 'merge', diffusion WS", async () => {
    const ctx = await monterServeurEnReview();
    poignee = ctx.poignee;

    // Client WS branché comme le dashboard : il doit recevoir le statut merged.
    const statutsRecus: (Stage | undefined)[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${ctx.poignee.port}/ws`);
    ws.on('message', (donnees) => {
      const message = JSON.parse(donnees.toString()) as WsMessage;
      if (message.kind === 'status') statutsRecus.push(message.status?.stage);
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve);
      ws!.once('error', reject);
    });

    // L'appel réseau EXACT du bouton « Approuver et merger ».
    const reponse = await fetch(`${ctx.base}/api/actions/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(reponse.status).toBe(200);
    expect((await reponse.json()) as { ok: boolean }).toEqual({ ok: true });

    // status.json écrit sur disque : stage merged.
    expect(lireStatusJson(ctx.repoDir).stage).toBe('merged');

    // events.ndjson : l'événement 'merge' (équivalent merge_approved) est appendé.
    const types = lireEvents(ctx.repoDir).map((e) => e.type);
    expect(types).toContain('merge');
    expect(types.filter((t) => t === 'transition').length).toBeGreaterThan(0);

    // Le dashboard est rafraîchi : le WS a diffusé le statut merged.
    await attendre(
      () => (statutsRecus.includes('merged') ? true : undefined),
      5000,
      `statut merged jamais diffusé en WS (reçus: ${statutsRecus.join(', ')})`,
    );
  });

  it("POST /api/actions/return en review → 200, retour en coding, événement 'return_to_coder'", async () => {
    const ctx = await monterServeurEnReview();
    poignee = ctx.poignee;

    const reponse = await fetch(`${ctx.base}/api/actions/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'corrige la casse du message' }),
    });
    expect(reponse.status).toBe(200);

    // Le renvoi relance le cycle : l'itération suivante démarre en coding.
    const statut = lireStatusJson(ctx.repoDir);
    expect(['coding', 'gate_coder', 'testing', 'gate_tester', 'review']).toContain(statut.stage);

    const evenements = lireEvents(ctx.repoDir);
    const renvoi = evenements.find((e) => e.type === 'return_to_coder');
    expect(renvoi).toBeDefined();
    expect((renvoi!.data as { comment?: string }).comment).toBe('corrige la casse du message');

    // Laisse le cycle relancé se terminer avant de fermer le serveur.
    await attendre(
      () => (ctx.orchestrateur.getStatus()?.stage === 'review' ? true : undefined),
      20000,
      'le cycle relancé après renvoi ne revient pas en review',
    );
  });

  it('POST /api/actions/return sans commentaire → 400 avec erreur exacte, aucun changement', async () => {
    const ctx = await monterServeurEnReview();
    poignee = ctx.poignee;

    const reponse = await fetch(`${ctx.base}/api/actions/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: '   ' }),
    });
    expect(reponse.status).toBe(400);
    const corps = (await reponse.json()) as { error: string };
    expect(corps.error).toContain('commentaire obligatoire');
    expect(lireStatusJson(ctx.repoDir).stage).toBe('review');
  });

  it("POST /api/actions/abort en review → 200, status.json = aborted, événement 'abort'", async () => {
    const ctx = await monterServeurEnReview();
    poignee = ctx.poignee;

    const reponse = await fetch(`${ctx.base}/api/actions/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(reponse.status).toBe(200);
    expect(lireStatusJson(ctx.repoDir).stage).toBe('aborted');
    expect(lireEvents(ctx.repoDir).map((e) => e.type)).toContain('abort');
  });

  it('POST /api/actions/merge hors review → 409 avec message explicite (jamais un échec silencieux)', async () => {
    const ctx = await monterServeurEnReview();
    poignee = ctx.poignee;

    // Merge une première fois (review → merged), puis re-merge : doit refuser clairement.
    await fetch(`${ctx.base}/api/actions/merge`, { method: 'POST' });
    const rejoue = await fetch(`${ctx.base}/api/actions/merge`, { method: 'POST' });
    expect(rejoue.status).toBe(409);
    const corps = (await rejoue.json()) as { error: string };
    expect(corps.error).toContain('Merge impossible');
  });
});
