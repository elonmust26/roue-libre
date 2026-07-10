/**
 * Preuve Phase 1 (moteur) — trou de reprise corrigé : un serveur tué pendant
 * gate_coder ou gate_tester laissait la tâche figée en silence au redémarrage
 * (dashboard vivant en apparence, boutons de la Revue morts sans message :
 * exactement le symptôme « clic sans effet »). start() doit reprendre le cycle
 * depuis TOUS les stages actifs.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../src/core/engine.js';
import { createInitialStatus, sha256File, StatusStore } from '../src/core/state.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { DEFAULT_CONFIG, ORCH_DIR, SPEC_FILE, STATUS_FILE } from '../src/core/types.js';
import type { RoueConfig, Stage } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Prépare un repo avec une tâche persistée au stage donné (comme après un kill). */
function preparerRepoAuStage(stage: Stage) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-resume-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const cheminSpec = path.join(repoDir, SPEC_FILE);
  fs.writeFileSync(cheminSpec, '# Spec figée — reprise\n\ncritère : demo.txt contient OK\n');

  const config: RoueConfig = { ...DEFAULT_CONFIG, budget_usd: 5, max_iterations: 3, timeout_minutes: 1 };
  const statut = createInitialStatus({
    taskId: 'resume-test',
    project: 'demo',
    risk: 'low',
    description: 'démo reprise',
    successCriterion: 'demo.txt contient OK',
    config,
  });
  statut.stage = stage;
  statut.spec_hash = sha256File(cheminSpec);
  new StatusStore(path.join(repoDir, STATUS_FILE)).save(statut);

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

async function attendreReview(orchestrateur: Orchestrator): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < 20000) {
    const statut = orchestrateur.getStatus();
    if (statut?.stage === 'review') return;
    if (statut?.stage === 'blocked') {
      throw new Error(`cycle bloqué (motif: ${String(statut.blocked_reason)})`);
    }
    await pause(50);
  }
  throw new Error(`timeout: review jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`);
}

describe('reprise du cycle au démarrage — start() couvre tous les stages actifs', () => {
  it('tâche persistée en gate_tester → start() reprend et atteint review', async () => {
    const { orchestrateur } = preparerRepoAuStage('gate_tester');
    await orchestrateur.start();
    await attendreReview(orchestrateur);
    expect(orchestrateur.getStatus()?.stage).toBe('review');
  });

  it('tâche persistée en gate_coder → start() reprend et atteint review', async () => {
    const { orchestrateur } = preparerRepoAuStage('gate_coder');
    await orchestrateur.start();
    await attendreReview(orchestrateur);
    expect(orchestrateur.getStatus()?.stage).toBe('review');
  });

  it('tâche persistée en review → start() ne relance RIEN (le cycle attend l\'action utilisateur)', async () => {
    const { orchestrateur } = preparerRepoAuStage('review');
    await orchestrateur.start();
    await pause(400);
    expect(orchestrateur.getStatus()?.stage).toBe('review');
  });
});
