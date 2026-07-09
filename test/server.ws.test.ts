/**
 * Test serveur + WebSocket — Definition of Done §10.4.
 * Preuve automatisée : GET / répond 200 (même sans dashboard buildé),
 * l'API REST répond, et AU MOINS UN événement transite par le WS pendant
 * un cycle simulé.
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
import type { RoueConfig, ServerHandle, Stage, WsMessage } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attend qu'un prédicat rende une valeur définie (poll toutes les 50 ms). */
async function attendre<T>(predicat: () => T | undefined, timeoutMs: number, motif: string): Promise<T> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    const valeur = predicat();
    if (valeur !== undefined) return valeur;
    await pause(50);
  }
  throw new Error(`timeout: ${motif}`);
}

function monterOrchestrateur() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-ws-'));
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
  return { repoDir, orchestrateur };
}

async function attendreStage(
  orchestrateur: { getStatus(): { stage: Stage } | null },
  cible: Stage,
  timeoutMs = 20000,
): Promise<void> {
  await attendre(
    () => (orchestrateur.getStatus()?.stage === cible ? true : undefined),
    timeoutMs,
    `stage "${cible}" jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`,
  );
}

describe('serveur HTTP + WebSocket', () => {
  let poignee: ServerHandle | null = null;
  let ws: WebSocket | null = null;

  afterEach(async () => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
    if (poignee) await poignee.close();
    poignee = null;
  });

  it('GET / répond 200 même sans dashboard buildé, et /api/status /api/config répondent en JSON', async () => {
    const { orchestrateur } = monterOrchestrateur();
    const port = 4790 + Math.floor(Math.random() * 150);
    poignee = await startServer({ port, orchestrator: orchestrateur });

    const racine = await fetch(`http://127.0.0.1:${poignee.port}/`);
    expect(racine.status).toBe(200);

    const statut = await fetch(`http://127.0.0.1:${poignee.port}/api/status`);
    expect(statut.status).toBe(200);
    // StatusJson | null — les deux sont valides tant que le JSON parse.
    const corpsStatut = (await statut.json()) as unknown;
    expect(corpsStatut === null || typeof corpsStatut === 'object').toBe(true);

    const config = await fetch(`http://127.0.0.1:${poignee.port}/api/config`);
    expect(config.status).toBe(200);
    const corpsConfig = (await config.json()) as { port?: number; max_iterations?: number };
    expect(corpsConfig.max_iterations).toBe(3);
  });

  it('au moins un événement transite par le WebSocket pendant un cycle simulé (preuve DoD §10.4)', async () => {
    const { orchestrateur } = monterOrchestrateur();
    const port = 4790 + Math.floor(Math.random() * 150);
    poignee = await startServer({ port, orchestrator: orchestrateur });

    const messages: WsMessage[] = [];
    ws = new WebSocket(`ws://127.0.0.1:${poignee.port}/ws`);
    ws.on('message', (donnees) => {
      messages.push(JSON.parse(donnees.toString()) as WsMessage);
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve);
      ws!.once('error', reject);
    });

    // Premier message : le statut courant ({kind:'status'}).
    const premier = await attendre(() => messages[0], 5000, 'aucun message WS initial');
    expect(premier.kind).toBe('status');

    // Déclenche un cycle simulé : des événements doivent transiter par le WS.
    await orchestrateur.createTask({
      description: 'démo',
      success_criterion: 'le fichier demo.txt contient OK',
      risk_level: 'low',
    });
    await orchestrateur.confirmTask();

    const evenement = await attendre(
      () => messages.find((m) => m.kind === 'event'),
      15000,
      "aucun message {kind:'event'} reçu sur le WS",
    );
    expect(evenement.kind).toBe('event');
    if (evenement.kind === 'event') {
      expect(typeof evenement.event.id).toBe('string');
      expect(typeof evenement.event.type).toBe('string');
    }

    // Laisse le cycle se terminer proprement en review avant la fermeture.
    await attendreStage(orchestrateur, 'review');
  });
});
