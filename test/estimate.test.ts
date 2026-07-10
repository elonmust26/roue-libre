/**
 * v0.2 — estimation de coût avant lancement (dry-run) : basée sur la taille
 * de la spec et l'historique local des tâches terminées, avec avertissement
 * de dépassement de budget.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../src/core/engine.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { DEFAULT_CONFIG, ORCH_DIR, SPEC_FILE, TASK_HISTORY_FILE } from '../src/core/types.js';
import type { RoueConfig, TaskHistoryEntry } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

function monterOrchestrateur(budget = 5) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-estim-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const config: RoueConfig = { ...DEFAULT_CONFIG, budget_usd: budget };
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

function ecrireSpec(repoDir: string, chars: number): void {
  fs.writeFileSync(path.join(repoDir, SPEC_FILE), 'x'.repeat(chars));
}

function ecrireHistorique(repoDir: string, entrees: TaskHistoryEntry[]): void {
  fs.writeFileSync(path.join(repoDir, TASK_HISTORY_FILE), JSON.stringify(entrees));
}

describe('estimation de coût (v0.2)', () => {
  it("sans historique : heuristique de taille de spec, jamais 0, base explicite", async () => {
    const { repoDir, orchestrateur } = monterOrchestrateur();
    ecrireSpec(repoDir, 4000);
    const estimation = await orchestrateur.estimateCost();
    expect(estimation.estimated_usd).toBeGreaterThan(0);
    expect(estimation.sample_size).toBe(0);
    expect(estimation.basis).toContain('heuristique');
    expect(estimation.over_budget).toBe(false);
    expect(estimation.budget_usd).toBe(5);
  });

  it('avec historique : coût moyen par caractère appliqué à la spec courante', async () => {
    const { repoDir, orchestrateur } = monterOrchestrateur();
    // Historique : 0.001 $/caractère en moyenne (2 tâches).
    ecrireHistorique(repoDir, [
      { task_id: 'a', description: 'a', spec_chars: 1000, cost_usd: 1, final_stage: 'merged', at: '2026-01-01T00:00:00Z' },
      { task_id: 'b', description: 'b', spec_chars: 2000, cost_usd: 2, final_stage: 'merged', at: '2026-01-02T00:00:00Z' },
    ]);
    ecrireSpec(repoDir, 3000);
    const estimation = await orchestrateur.estimateCost();
    expect(estimation.sample_size).toBe(2);
    expect(estimation.basis).toContain('historique');
    // 0.001 $/char × 3000 chars = 3 $ (± arrondi au centime).
    expect(estimation.estimated_usd).toBeCloseTo(3, 1);
    expect(estimation.over_budget).toBe(false);
  });

  it('avertit quand l\'estimation dépasse le budget configuré', async () => {
    const { repoDir, orchestrateur } = monterOrchestrateur(0.5);
    ecrireHistorique(repoDir, [
      { task_id: 'a', description: 'a', spec_chars: 1000, cost_usd: 2, final_stage: 'merged', at: '2026-01-01T00:00:00Z' },
    ]);
    ecrireSpec(repoDir, 1000);
    const estimation = await orchestrateur.estimateCost();
    expect(estimation.estimated_usd).toBeGreaterThan(0.5);
    expect(estimation.over_budget).toBe(true);
  });

  it("l'historique s'archive automatiquement à la fin d'une tâche (base de la prochaine estimation)", async () => {
    const { repoDir, orchestrateur } = monterOrchestrateur();
    await orchestrateur.enqueueTask({
      description: 'tâche archivée',
      success_criterion: 'demo.txt contient OK',
      risk_level: 'low',
    });
    const debut = Date.now();
    while (Date.now() - debut < 20000 && orchestrateur.getStatus()?.stage !== 'review') {
      await new Promise((r) => setTimeout(r, 50));
    }
    await orchestrateur.merge();
    const histoire = JSON.parse(
      fs.readFileSync(path.join(repoDir, TASK_HISTORY_FILE), 'utf8'),
    ) as TaskHistoryEntry[];
    expect(histoire.length).toBe(1);
    expect(histoire[0].description).toBe('tâche archivée');
    expect(histoire[0].final_stage).toBe('merged');
    expect(histoire[0].cost_usd).toBeGreaterThan(0);
    expect(histoire[0].spec_chars).toBeGreaterThan(0);
  });
});
