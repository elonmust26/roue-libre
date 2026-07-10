/**
 * Mode simulation (--simulate) : implémentations factices de RoleRunner,
 * GateRunner et GitOps. Zéro token, zéro réseau, zéro git réel.
 *
 * C'est le socle du test e2e (Definition of Done §10.3) :
 * - le runner rejoue des réponses scriptées par rôle avec des coûts factices ;
 * - la gate testeur ÉCHOUE au premier appel puis passe — c'est l'échec injecté
 *   qui prouve que la boucle d'itération du moteur fonctionne ;
 * - les opérations git sont des stubs qui enregistrent leurs appels.
 */

import type {
  GateResult,
  GateRunner,
  GitOps,
  RoleName,
  RoleRunRequest,
  RoleRunResult,
  RoleRunner,
  RunnerChunk,
} from '../core/types.js';
import {
  COUTS_SIMULES,
  DIFF_SIMULE,
  PR_URL_SIMULEE,
  estUneIteration,
  extraitPrompt,
  recitCoder,
  resumeTesteur,
  specSimulee,
} from './fixtures.js';

/** Petite pause pour rendre le flux de chunks réaliste (temps réel côté dashboard). */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maintenant(): string {
  return new Date().toISOString();
}

export interface SimulatedRunnerOptions {
  /** Délai entre deux chunks émis (défaut ~20 ms). */
  delayMs?: number;
}

/**
 * RoleRunner simulé : émet des chunks NDJSON au format stream-json de
 * `claude -p` (lignes "system" / "assistant" puis une finale "result"),
 * et rend un RoleRunResult scripté par rôle.
 */
export class SimulatedRunner implements RoleRunner {
  /** Historique des appels, exposé en lecture pour les tests. */
  readonly calls: Array<{ role: RoleName; promptExcerpt: string }> = [];

  private readonly delayMs: number;
  private readonly compteurs: Record<RoleName, number> = {
    prompteur: 0,
    coder: 0,
    testeur: 0,
  };

  constructor(options: SimulatedRunnerOptions = {}) {
    this.delayMs = options.delayMs ?? 20;
  }

  async run(req: RoleRunRequest, onChunk: (chunk: RunnerChunk) => void): Promise<RoleRunResult> {
    const n = ++this.compteurs[req.role];
    const sessionId = `sim-${req.role}-${n}`;
    this.calls.push({ role: req.role, promptExcerpt: extraitPrompt(req.prompt) });

    const resultText = this.texteResultat(req);
    const costUsd = COUTS_SIMULES[req.role];

    // Flux NDJSON réaliste : init système → réponse assistant → résultat final.
    const lignes: Array<Record<string, unknown>> = [
      {
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model: req.model,
        cwd: req.cwd,
        tools: req.allowedTools,
      },
      {
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: resultText }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        total_cost_usd: costUsd,
        num_turns: 1,
        duration_ms: this.delayMs * 3,
        result: resultText,
      },
    ];

    for (const parsed of lignes) {
      await pause(this.delayMs);
      onChunk({ role: req.role, raw: JSON.stringify(parsed), parsed });
    }

    return {
      ok: true,
      sessionId,
      costUsd,
      resultText,
      exitCode: 0,
      timedOut: false,
      stderrTail: '',
    };
  }

  /** Réponse scriptée selon le rôle (spec §6 : chaque rôle rend SON livrable). */
  private texteResultat(req: RoleRunRequest): string {
    switch (req.role) {
      case 'prompteur':
        return specSimulee(req.prompt);
      case 'coder':
        return recitCoder(req.prompt);
      case 'testeur':
        return resumeTesteur(req.prompt);
    }
  }
}

/**
 * GateRunner simulé :
 * - gate 'coder' : passe toujours (diff non vide, typecheck OK, tests OK) ;
 * - gate 'tester' : échoue au 1er appel puis passe — échec injecté qui
 *   force le moteur à boucler (iteration + 1) et prouve la boucle en e2e.
 */
export class SimulatedGateRunner implements GateRunner {
  /** Historique des appels, exposé en lecture pour les tests. */
  readonly calls: Array<{ gate: 'coder' | 'tester'; cwd: string }> = [];
  /** Compteurs d'appels par gate, exposés pour les tests. */
  readonly counts: { coder: number; tester: number } = { coder: 0, tester: 0 };

  async run(gate: 'coder' | 'tester', cwd: string): Promise<GateResult> {
    this.calls.push({ gate, cwd });
    this.counts[gate] += 1;
    const debut = Date.now();
    await pause(5); // durée factice mais non nulle

    if (gate === 'tester' && this.counts.tester === 1) {
      // Échec injecté à la première passe du testeur.
      return {
        name: 'tester',
        ok: false,
        exit_code: 1,
        duration_ms: Math.max(1, Date.now() - debut),
        stdout: 'Tests relancés à froid : 1 test échoué : demo.txt ne contient pas OK',
        stderr: "AssertionError: expected demo.txt to contain 'OK'",
        at: maintenant(),
      };
    }

    return {
      name: gate,
      ok: true,
      exit_code: 0,
      duration_ms: Math.max(1, Date.now() - debut),
      stdout:
        gate === 'coder'
          ? 'diff non vide, typecheck OK, tests OK'
          : 'Tests relancés à froid : exit 0 — build clean, demo.txt contient OK',
      stderr: '',
      at: maintenant(),
    };
  }
}

export interface SimulatedGitOpsOptions {
  /**
   * Répertoire retourné par ensureWorktree (le moteur le passe ensuite comme
   * cwd au runner simulé, qui ne s'en sert pas). Défaut : process.cwd().
   */
  repoDir?: string;
}

/**
 * GitOps simulé : stubs purs, aucun accès disque ni processus git.
 * Toutes les méthodes enregistrent leurs appels dans `calls`.
 */
export class SimulatedGitOps implements GitOps {
  /** Historique des appels, exposé en lecture pour les tests. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  private readonly repoDir: string;

  constructor(options: SimulatedGitOpsOptions = {}) {
    this.repoDir = options.repoDir ?? process.cwd();
  }

  async ensureWorktree(role: RoleName, branch: string): Promise<string> {
    this.calls.push({ method: 'ensureWorktree', args: [role, branch] });
    // Chemin factice : on rend le repoDir tel quel, sans toucher au disque.
    return this.repoDir;
  }

  async targetBranch(): Promise<string> {
    this.calls.push({ method: 'targetBranch', args: [] });
    return 'main';
  }

  async diffAgainstTarget(branch: string): Promise<string> {
    this.calls.push({ method: 'diffAgainstTarget', args: [branch] });
    return DIFF_SIMULE;
  }

  async createPr(branch: string, title: string, body: string): Promise<string> {
    this.calls.push({ method: 'createPr', args: [branch, title, body] });
    return PR_URL_SIMULEE;
  }

  async mergePr(url: string): Promise<void> {
    this.calls.push({ method: 'mergePr', args: [url] });
  }

  async removeWorktrees(): Promise<void> {
    this.calls.push({ method: 'removeWorktrees', args: [] });
  }
}

// Ré-export pratique pour les tests et le CLI (--simulate).
export { COUTS_SIMULES, DIFF_SIMULE, PR_URL_SIMULEE, estUneIteration };
