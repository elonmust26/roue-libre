/**
 * Contrat de types partagé de roue-libre.
 * TOUT le monde (core, server, sim, dashboard via miroir) s'aligne sur ce fichier.
 * La machine d'états et le format status.json suivent la spec §4 du PRD.
 */

export type Stage =
  | 'idle'
  | 'spec_locked'
  | 'coding'
  | 'gate_coder'
  | 'testing'
  | 'gate_tester'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'aborted';

export type RoleName = 'prompteur' | 'coder' | 'testeur';

export type RiskLevel = 'low' | 'medium' | 'high';

export type AlertType =
  | 'loop'
  | 'timeout'
  | 'budget'
  | 'gate_failed_repeated'
  | 'spec_altered';

/** status.json — écrit UNIQUEMENT par le moteur, atomiquement (tmp + rename). */
export interface StatusJson {
  task_id: string;
  project: string;
  risk_level: RiskLevel;
  spec_path: string;
  /** sha256 hex de spec.md au moment du verrouillage — vérifié à chaque étape. */
  spec_hash: string | null;
  stage: Stage;
  iteration: number;
  max_iterations: number;
  budget_usd: number;
  cost_usd_used: number;
  timeout_minutes: number;
  last_transition_at: string; // iso8601
  /** Motif si stage === 'blocked'. */
  blocked_reason: AlertType | null;
  sessions: Record<RoleName, string | null>;
  gates: { coder: GateResult | null; tester: GateResult | null };
  history_file: string;
  /** Description de la tâche et critère de succès (saisis à la création). */
  description: string;
  success_criterion: string;
  /** Commentaire de renvoi (écran Revue) — instruction figée de l'itération suivante. */
  return_comment: string | null;
  /** URL de la PR ouverte par le testeur, si existante. */
  pr_url: string | null;
}

export interface GateResult {
  name: 'coder' | 'tester';
  ok: boolean;
  exit_code: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  at: string; // iso8601
}

export type EventType =
  | 'task_created'
  | 'spec_locked'
  | 'prompt_sent'
  | 'chunk'
  | 'role_result'
  | 'gate_passed'
  | 'gate_failed'
  | 'transition'
  | 'alert'
  | 'merge'
  | 'abort'
  | 'return_to_coder';

/** Événement appendé dans events.ndjson et poussé en WS (source de la Timeline). */
export interface OrchestratorEvent {
  id: string;
  at: string; // iso8601
  type: EventType;
  role: RoleName | null;
  stage: Stage;
  iteration: number;
  /** Charge utile libre : prompt exact, chunk de sortie, GateResult, from/to de transition, AlertType… */
  data: Record<string, unknown>;
}

/** Requête d'exécution d'un rôle par le moteur. */
export interface RoleRunRequest {
  role: RoleName;
  /** Prompt complet : intégralité de spec.md + brief du rôle (jamais de résumé). */
  prompt: string;
  /** Répertoire de travail (worktree du rôle). */
  cwd: string;
  model: string;
  allowedTools: string[];
  timeoutMs: number;
  /** session à reprendre (--resume), sinon null. */
  resumeSessionId: string | null;
}

export interface RoleRunResult {
  ok: boolean;
  sessionId: string | null;
  costUsd: number;
  resultText: string;
  exitCode: number;
  timedOut: boolean;
}

/** Chunk NDJSON relayé en temps réel (stream-json de claude -p, ou stub simulé). */
export interface RunnerChunk {
  role: RoleName;
  raw: string;
  parsed: Record<string, unknown> | null;
}

/**
 * Abstraction du moteur d'exécution : implémentée par HeadlessRunner (claude -p réel)
 * et SimulatedRunner (fixtures, zéro token). Le moteur ne connaît que cette interface.
 */
export interface RoleRunner {
  run(req: RoleRunRequest, onChunk: (chunk: RunnerChunk) => void): Promise<RoleRunResult>;
}

/** Exécuteur de gates shell — seule voie de transition. */
export interface GateRunner {
  run(gate: 'coder' | 'tester', cwd: string): Promise<GateResult>;
}

export interface RoleConfig {
  model: string;
  allowedTools: string[];
}

/** roue.config.json — défauts fusionnés avec .orchestration/config.json du repo cible. */
export interface RoueConfig {
  port: number;
  max_iterations: number;
  timeout_minutes: number;
  budget_usd: number;
  default_risk: RiskLevel;
  roles: Record<RoleName, RoleConfig>;
  gates: { coder: string; tester: string };
}

export const DEFAULT_CONFIG: RoueConfig = {
  port: 4700,
  max_iterations: 3,
  timeout_minutes: 10,
  budget_usd: 5.0,
  default_risk: 'medium',
  roles: {
    prompteur: {
      model: 'claude-fable-5',
      allowedTools: ['Read', 'Glob', 'Grep'],
    },
    coder: {
      model: 'claude-fable-5',
      allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(npm run:*)', 'Bash(npm test:*)'],
    },
    testeur: {
      model: 'claude-fable-5',
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash(npm ci:*)', 'Bash(npm test:*)', 'Bash(npm run:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git push:*)', 'Bash(gh pr create:*)'],
    },
  },
  gates: { coder: 'gates/coder.sh', tester: 'gates/tester.sh' },
};

/** Transitions autorisées de la machine d'états. Toute autre transition est un bug. */
export const TRANSITIONS: Record<Stage, Stage[]> = {
  idle: ['spec_locked', 'aborted'],
  spec_locked: ['coding', 'aborted'],
  coding: ['gate_coder', 'blocked', 'aborted'],
  gate_coder: ['testing', 'coding', 'blocked', 'aborted'],
  testing: ['gate_tester', 'blocked', 'aborted'],
  gate_tester: ['review', 'coding', 'blocked', 'aborted'],
  review: ['merged', 'coding', 'aborted'],
  merged: [],
  blocked: ['coding', 'testing', 'spec_locked', 'aborted'],
  aborted: [],
};

/* ------------------------------------------------------------------ */
/* Chemins canoniques dans le repo cible                               */
/* ------------------------------------------------------------------ */

export const ORCH_DIR = '.orchestration';
export const STATUS_FILE = '.orchestration/status.json';
export const EVENTS_FILE = '.orchestration/events.ndjson';
export const SPEC_FILE = '.orchestration/spec.md';
export const LOCAL_CONFIG_FILE = '.orchestration/config.json';
export const WORKTREES_DIR = '.orchestration/worktrees';

/* ------------------------------------------------------------------ */
/* Opérations git — stubbées en mode --simulate                        */
/* ------------------------------------------------------------------ */

export interface GitOps {
  /** Crée (si besoin) le worktree du rôle sur la branche donnée. Retourne son chemin absolu. */
  ensureWorktree(role: RoleName, branch: string): Promise<string>;
  /** Branche cible (celle d'où part la tâche). */
  targetBranch(): Promise<string>;
  /** Diff unifié branche de tâche vs branche cible. */
  diffAgainstTarget(branch: string): Promise<string>;
  /** Ouvre une PR via gh. Retourne l'URL. */
  createPr(branch: string, title: string, body: string): Promise<string>;
  /** Merge la PR via gh (uniquement appelé par l'action dashboard). */
  mergePr(url: string): Promise<void>;
  /** Nettoie les worktrees de la tâche. */
  removeWorktrees(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Façade orchestrateur — implémentée par le moteur (SA-core),         */
/* consommée par le serveur (SA-ui) et les tests (SA-qa)               */
/* ------------------------------------------------------------------ */

export interface OrchestratorApi {
  getStatus(): StatusJson | null;
  getEvents(limit?: number): Promise<OrchestratorEvent[]>;
  getConfig(): RoueConfig;
  setConfig(patch: Partial<RoueConfig>): Promise<RoueConfig>;
  /** Crée la tâche et génère l'aperçu de spec (pas encore verrouillée). */
  createTask(req: TaskCreateRequest): Promise<{ spec_preview: string }>;
  /** Verrouille la spec (hash) et démarre le cycle en arrière-plan. */
  confirmTask(): Promise<void>;
  /** Action dashboard : merge de la PR (stage review uniquement). */
  merge(): Promise<void>;
  /** Action dashboard : renvoi au coder — le commentaire devient instruction figée de l'itération suivante. */
  returnToCoder(comment: string): Promise<void>;
  abort(): Promise<void>;
  /** Depuis blocked : relance depuis l'étape bloquée. */
  retry(): Promise<void>;
  getDiff(): Promise<DiffReview>;
  /** Abonnements temps réel (retournent une fonction de désabonnement). */
  onEvent(listener: (e: OrchestratorEvent) => void): () => void;
  onStatus(listener: (s: StatusJson | null) => void): () => void;
}

export interface ServerOptions {
  port: number;
  orchestrator: OrchestratorApi;
  /** Chemin du build dashboard (dashboard/dist). Si absent, page de repli inline. */
  dashboardDist?: string;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Contrat API REST + WS entre server et dashboard                     */
/* ------------------------------------------------------------------ */

/** GET /api/status → StatusJson | null ; GET /api/events?limit=n → OrchestratorEvent[] */
/** GET /api/config → RoueConfig ; PUT /api/config (body: Partial<RoueConfig>) */
/** POST /api/task (body: TaskCreateRequest) → { spec_preview: string } */
/** POST /api/task/confirm → verrouille la spec et démarre le cycle */
/** POST /api/actions/merge | /api/actions/abort | /api/actions/retry */
/** POST /api/actions/return (body: { comment: string }) */
/** GET /api/diff → DiffReview */

export interface TaskCreateRequest {
  description: string;
  success_criterion: string;
  risk_level: RiskLevel;
  project?: string;
}

export interface DiffReview {
  diff: string;
  tester_summary: string;
  gate_tester: GateResult | null;
  pr_url: string | null;
}

/** Messages WebSocket poussés par le serveur. */
export type WsMessage =
  | { kind: 'event'; event: OrchestratorEvent }
  | { kind: 'status'; status: StatusJson | null };
