/**
 * Test e2e simulé — Definition of Done §10.3.
 * Cycle complet sans un seul token : SimulatedRunner + SimulatedGateRunner +
 * SimulatedGitOps branchés sur le vrai Orchestrator.
 *
 * L'échec injecté de gate_tester (1er appel) doit provoquer un retour en
 * coding avec iteration + 1, puis le cycle doit s'ARRÊTER en review
 * (jamais de merge automatique).
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../src/core/engine.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { COUTS_SIMULES, PR_URL_SIMULEE } from '../src/sim/fixtures.js';
import { DEFAULT_CONFIG, ORCH_DIR } from '../src/core/types.js';
import type { OrchestratorEvent, RoueConfig, Stage } from '../src/core/types.js';

const RACINE_PACKAGE = fileURLToPath(new URL('..', import.meta.url));

const STAGES: Stage[] = [
  'idle',
  'spec_locked',
  'coding',
  'gate_coder',
  'testing',
  'gate_tester',
  'review',
  'merged',
  'blocked',
  'aborted',
];

const TYPES_EVENEMENT = [
  'task_created',
  'spec_locked',
  'prompt_sent',
  'chunk',
  'role_result',
  'gate_passed',
  'gate_failed',
  'transition',
  'alert',
  'merge',
  'abort',
  'return_to_coder',
];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Monte un orchestrateur simulé complet dans un repoDir temporaire. */
function monterOrchestrateur() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-e2e-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });

  const config: RoueConfig = {
    ...DEFAULT_CONFIG,
    budget_usd: 5,
    max_iterations: 3,
    timeout_minutes: 1, // timeout court : le cycle simulé se joue en < 2 s
  };
  const runner = new SimulatedRunner();
  const gates = new SimulatedGateRunner();
  const git = new SimulatedGitOps({ repoDir });

  const orchestrateur = new Orchestrator({
    repoDir,
    packageRoot: RACINE_PACKAGE,
    config,
    runner,
    gates,
    git,
  });

  return { repoDir, config, runner, gates, git, orchestrateur };
}

/** Attend (poll) que le stage demandé soit atteint ; échoue vite si blocked. */
async function attendreStage(
  orchestrateur: { getStatus(): { stage: Stage; blocked_reason: unknown } | null },
  cible: Stage,
  timeoutMs = 20000,
): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    const statut = orchestrateur.getStatus();
    if (statut?.stage === cible) return;
    if (statut?.stage === 'blocked' && cible !== 'blocked') {
      throw new Error(`cycle bloqué (motif: ${String(statut.blocked_reason)}) en attendant ${cible}`);
    }
    await pause(50);
  }
  throw new Error(`timeout: stage "${cible}" jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`);
}

/** Lance createTask + confirmTask et attend l'arrivée en review. */
async function deroulerJusquaReview(ctx: ReturnType<typeof monterOrchestrateur>): Promise<void> {
  const { spec_preview } = await ctx.orchestrateur.createTask({
    description: 'démo',
    success_criterion: 'le fichier demo.txt contient OK',
    risk_level: 'low',
  });
  expect(spec_preview.length).toBeGreaterThan(0);
  await ctx.orchestrateur.confirmTask();
  await attendreStage(ctx.orchestrateur, 'review');
}

/** Vérifie qu'une sous-séquence apparaît dans l'ordre (non nécessairement contiguë). */
function contientSousSequence(sequence: string[], attendue: string[]): boolean {
  let i = 0;
  for (const element of sequence) {
    if (element === attendue[i]) i += 1;
    if (i === attendue.length) return true;
  }
  return i === attendue.length;
}

describe('e2e simulé — cycle complet', () => {
  it("déroule spec → coding → gates → review avec l'échec injecté qui force l'itération 2", async () => {
    const ctx = monterOrchestrateur();
    const { orchestrateur, repoDir, runner, git } = ctx;

    // --- Création de tâche : aperçu de spec + spec.md écrite dans .orchestration/
    const { spec_preview } = await orchestrateur.createTask({
      description: 'démo',
      success_criterion: 'le fichier demo.txt contient OK',
      risk_level: 'low',
    });
    expect(spec_preview.trim().length).toBeGreaterThan(0);

    const cheminSpec = path.join(repoDir, ORCH_DIR, 'spec.md');
    expect(fs.existsSync(cheminSpec)).toBe(true);
    expect(fs.readFileSync(cheminSpec, 'utf8').trim().length).toBeGreaterThan(0);

    // --- Confirmation : verrouillage + cycle en arrière-plan jusqu'à review
    await orchestrateur.confirmTask();
    await attendreStage(orchestrateur, 'review');

    const statut = orchestrateur.getStatus();
    expect(statut).not.toBeNull();
    if (!statut) throw new Error('statut null après review');

    // L'échec injecté de gate_tester a bien relancé un tour complet.
    expect(statut.iteration).toBe(2);
    expect(runner.calls.filter((c) => c.role === 'coder').length).toBe(2);
    // La gate testeur est passée au final.
    expect(statut.gates.tester?.ok).toBe(true);
    // La PR simulée a été ouverte.
    expect(statut.pr_url).toBe(PR_URL_SIMULEE);

    // --- Le cycle S'ARRÊTE en review : pas de merge automatique.
    await pause(300);
    expect(orchestrateur.getStatus()?.stage).toBe('review');
    expect(git.calls.some((c) => c.method === 'mergePr')).toBe(false);

    // --- Budget : coût cumulé > 0 et égal à la somme des coûts factices des runs.
    const coutAttendu = runner.calls.reduce((somme, c) => somme + COUTS_SIMULES[c.role], 0);
    expect(statut.cost_usd_used).toBeGreaterThan(0);
    expect(statut.cost_usd_used).toBeCloseTo(coutAttendu, 6);

    // --- events.ndjson : existe, NDJSON valide, contenu contractuel.
    const cheminEvents = path.join(repoDir, ORCH_DIR, 'events.ndjson');
    expect(fs.existsSync(cheminEvents)).toBe(true);

    const evenements: OrchestratorEvent[] = fs
      .readFileSync(cheminEvents, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as OrchestratorEvent);
    expect(evenements.length).toBeGreaterThan(0);

    // Chaque événement a id/at/type/stage valides.
    for (const e of evenements) {
      expect(typeof e.id, JSON.stringify(e)).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(Number.isFinite(Date.parse(e.at))).toBe(true);
      expect(TYPES_EVENEMENT).toContain(e.type);
      expect(STAGES).toContain(e.stage);
    }

    const types = evenements.map((e) => e.type);
    expect(types).toContain('task_created');
    expect(types).toContain('spec_locked');

    // Au moins un prompt_sent par rôle utilisé.
    const rolesPrompts = new Set(evenements.filter((e) => e.type === 'prompt_sent').map((e) => e.role));
    expect(rolesPrompts.has('prompteur')).toBe(true);
    expect(rolesPrompts.has('coder')).toBe(true);
    expect(rolesPrompts.has('testeur')).toBe(true);

    // gate_failed : l'échec injecté du testeur, à l'itération 1.
    const echecsGate = evenements.filter((e) => e.type === 'gate_failed');
    expect(echecsGate.length).toBe(1);
    expect(echecsGate[0].iteration).toBe(1);
    expect(JSON.stringify(echecsGate[0]).toLowerCase()).toContain('tester');

    // gate_passed : au moins la passe finale du testeur.
    const passesGate = evenements.filter((e) => e.type === 'gate_passed');
    expect(passesGate.length).toBeGreaterThanOrEqual(1);
    expect(passesGate.map((e) => JSON.stringify(e).toLowerCase()).some((s) => s.includes('tester'))).toBe(true);

    // Transitions attendues, dans l'ordre (deux tours complets puis review).
    const destinations = evenements
      .filter((e) => e.type === 'transition')
      .map((e) => String((e.data as Record<string, unknown>).to));
    expect(
      contientSousSequence(destinations, [
        'coding',
        'gate_coder',
        'testing',
        'gate_tester',
        'coding', // retour après l'échec injecté (iteration 2)
        'gate_coder',
        'testing',
        'gate_tester',
        'review',
      ]),
      `séquence de transitions inattendue : ${destinations.join(' → ')}`,
    ).toBe(true);
  });

  it('merge() depuis review → stage merged, via SimulatedGitOps.mergePr', async () => {
    const ctx = monterOrchestrateur();
    await deroulerJusquaReview(ctx);

    await ctx.orchestrateur.merge();
    await attendreStage(ctx.orchestrateur, 'merged', 5000);

    expect(ctx.orchestrateur.getStatus()?.stage).toBe('merged');
    expect(ctx.git.calls.some((c) => c.method === 'mergePr')).toBe(true);
  });

  it('abort() depuis review → stage aborted, sans merge', async () => {
    const ctx = monterOrchestrateur();
    await deroulerJusquaReview(ctx);

    await ctx.orchestrateur.abort();
    await attendreStage(ctx.orchestrateur, 'aborted', 5000);

    expect(ctx.orchestrateur.getStatus()?.stage).toBe('aborted');
    expect(ctx.git.calls.some((c) => c.method === 'mergePr')).toBe(false);
  });
});
