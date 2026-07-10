/**
 * v0.2 — file d'attente de tâches : les tâches empilées s'exécutent
 * séquentiellement sans intervention (hors validation de merge, garde-fou 5),
 * chacune produisant sa propre PR.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../src/core/engine.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { DEFAULT_CONFIG, ORCH_DIR, QUEUE_FILE } from '../src/core/types.js';
import type { QueuedTask, RoueConfig, Stage } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monterOrchestrateur() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-queue-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const config: RoueConfig = { ...DEFAULT_CONFIG, budget_usd: 5, max_iterations: 3, timeout_minutes: 1 };
  const git = new SimulatedGitOps({ repoDir });
  const orchestrateur = new Orchestrator({
    repoDir,
    packageRoot: RACINE_PACKAGE,
    config,
    runner: new SimulatedRunner(),
    gates: new SimulatedGateRunner(),
    git,
  });
  return { repoDir, orchestrateur, git };
}

async function attendreStage(
  orchestrateur: Orchestrator,
  cible: Stage,
  timeoutMs = 20000,
): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    const statut = orchestrateur.getStatus();
    if (statut?.stage === cible) return;
    if (statut?.stage === 'blocked') {
      throw new Error(`cycle bloqué (motif: ${String(statut.blocked_reason)}) en attendant ${cible}`);
    }
    await pause(50);
  }
  throw new Error(`timeout: stage "${cible}" jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`);
}

describe("file d'attente de tâches (v0.2)", () => {
  it('deux tâches empilées : la 1re démarre seule, la 2e enchaîne après le merge, chacune avec sa PR', async () => {
    const { repoDir, orchestrateur, git } = monterOrchestrateur();

    // Empilage : aucune tâche active → la première démarre automatiquement.
    await orchestrateur.enqueueTask({
      description: 'tâche A',
      success_criterion: 'demo.txt contient OK',
      risk_level: 'low',
    });
    let file = await orchestrateur.enqueueTask({
      description: 'tâche B',
      success_criterion: 'demo.txt contient OK',
      risk_level: 'low',
    });
    // La tâche B reste en file tant que A tourne.
    expect(file.map((t) => t.description)).toContain('tâche B');

    await attendreStage(orchestrateur, 'review');
    const tacheA = orchestrateur.getStatus();
    expect(tacheA?.description).toBe('tâche A');
    expect(tacheA?.pr_url).toBeTruthy(); // PR de la tâche A

    // La file n'avance PAS pendant la review (merge = action humaine, garde-fou 5).
    await pause(300);
    expect(orchestrateur.getStatus()?.description).toBe('tâche A');
    expect(orchestrateur.getQueue().length).toBe(1);

    // Merge de A → B démarre sans intervention et atteint review avec SA PR.
    await orchestrateur.merge();
    const debut = Date.now();
    while (Date.now() - debut < 20000 && orchestrateur.getStatus()?.description !== 'tâche B') {
      await pause(50);
    }
    expect(orchestrateur.getStatus()?.description).toBe('tâche B');
    await attendreStage(orchestrateur, 'review');
    expect(orchestrateur.getStatus()?.pr_url).toBeTruthy();

    // Une PR par tâche : createPr appelé deux fois.
    expect(git.calls.filter((c) => c.method === 'createPr').length).toBe(2);

    // File vidée et persistée sur disque.
    expect(orchestrateur.getQueue()).toEqual([]);
    const surDisque = JSON.parse(fs.readFileSync(path.join(repoDir, QUEUE_FILE), 'utf8')) as QueuedTask[];
    expect(surDisque).toEqual([]);

    // Événements de file journalisés (enqueued ×2, started ×2).
    const evenements = fs
      .readFileSync(path.join(repoDir, ORCH_DIR, 'events.ndjson'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { type: string; data: { action?: string } });
    const actionsFile = evenements.filter((e) => e.type === 'queue').map((e) => e.data.action);
    expect(actionsFile.filter((a) => a === 'enqueued').length).toBe(2);
    expect(actionsFile.filter((a) => a === 'started').length).toBe(2);
  });

  it('retrait d\'une tâche en file avant son démarrage', async () => {
    const { orchestrateur } = monterOrchestrateur();
    await orchestrateur.enqueueTask({
      description: 'tâche A',
      success_criterion: 'ok',
      risk_level: 'low',
    });
    const file = await orchestrateur.enqueueTask({
      description: 'tâche à retirer',
      success_criterion: 'ok',
      risk_level: 'low',
    });
    const cible = file.find((t) => t.description === 'tâche à retirer');
    expect(cible).toBeDefined();
    const restante = await orchestrateur.removeQueuedTask(cible!.id);
    expect(restante.find((t) => t.id === cible!.id)).toBeUndefined();
    await expect(orchestrateur.removeQueuedTask('id-inexistant')).rejects.toThrow(/absente de la file/);
    // Laisse la tâche A (démarrée automatiquement) finir proprement.
    await attendreStage(orchestrateur, 'review');
  });
});
