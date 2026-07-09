/**
 * Machine d'états côté persistance : statut initial, écriture atomique
 * de status.json (tmp + rename), garde de transitions, hash de spec.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVENTS_FILE,
  SPEC_FILE,
  TRANSITIONS,
  type RiskLevel,
  type RoueConfig,
  type Stage,
  type StatusJson,
} from './types.js';

/** Construit le status.json initial d'une tâche (stage idle, compteurs à zéro). */
export function createInitialStatus(opts: {
  taskId: string;
  project: string;
  risk: RiskLevel;
  description: string;
  successCriterion: string;
  config: RoueConfig;
}): StatusJson {
  return {
    task_id: opts.taskId,
    project: opts.project,
    risk_level: opts.risk,
    spec_path: SPEC_FILE,
    spec_hash: null,
    stage: 'idle',
    iteration: 1,
    max_iterations: opts.config.max_iterations,
    budget_usd: opts.config.budget_usd,
    cost_usd_used: 0,
    timeout_minutes: opts.config.timeout_minutes,
    last_transition_at: new Date().toISOString(),
    blocked_reason: null,
    blocked_from: null,
    tester_summary: null,
    sessions: { prompteur: null, coder: null, testeur: null },
    gates: { coder: null, tester: null },
    history_file: EVENTS_FILE,
    description: opts.description,
    success_criterion: opts.successCriterion,
    return_comment: null,
    pr_url: null,
  };
}

/** Persistance de status.json — seule voie d'écriture, toujours atomique. */
export class StatusStore {
  private readonly statusPath: string;

  constructor(statusPath: string) {
    this.statusPath = statusPath;
  }

  load(): StatusJson | null {
    if (!fs.existsSync(this.statusPath)) return null;
    const raw = fs.readFileSync(this.statusPath, 'utf8');
    try {
      return JSON.parse(raw) as StatusJson;
    } catch (err) {
      throw new Error(
        `status.json illisible (${this.statusPath}) : ${(err as Error).message}`,
      );
    }
  }

  /** Écriture atomique : write dans <path>.tmp puis rename par-dessus la cible. */
  save(status: StatusJson): void {
    fs.mkdirSync(path.dirname(this.statusPath), { recursive: true });
    const tmp = `${this.statusPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(status, null, 2));
    try {
      fs.renameSync(tmp, this.statusPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Sous Windows, rename peut refuser d'écraser la cible : unlink puis rename.
      if (code === 'EEXIST' || code === 'EPERM') {
        try {
          fs.unlinkSync(this.statusPath);
        } catch {
          /* cible déjà absente */
        }
        fs.renameSync(tmp, this.statusPath);
      } else {
        throw err;
      }
    }
  }
}

/** Jette une erreur explicite si la transition n'est pas dans TRANSITIONS. */
export function assertTransition(from: Stage, to: Stage): void {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `Transition interdite : ${from} → ${to} (autorisées depuis ${from} : ${allowed.join(', ') || 'aucune'})`,
    );
  }
}

/** Sha256 hex du contenu d'un fichier (verrouillage de spec.md). */
export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
