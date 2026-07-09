/**
 * Cœur de roue-libre : HeadlessRunner (spawn de `claude -p`) et Orchestrator
 * (la boucle spec_locked → coding → gates → testing → review).
 *
 * Principe non négociable : AUCUNE transition n'est décidée par un agent.
 * Les rôles travaillent ; le moteur vérifie par gates shell et actions
 * utilisateur (merge / return / abort / retry), et c'est LUI qui transitionne.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EVENTS_FILE,
  LOCAL_CONFIG_FILE,
  ORCH_DIR,
  SPEC_FILE,
  STATUS_FILE,
  TRANSITIONS,
  type AlertType,
  type DiffReview,
  type EventType,
  type GateRunner,
  type GitOps,
  type OrchestratorApi,
  type OrchestratorEvent,
  type RoleName,
  type RoleRunner,
  type RoleRunRequest,
  type RoleRunResult,
  type RoueConfig,
  type RunnerChunk,
  type Stage,
  type StatusJson,
  type TaskCreateRequest,
} from './types.js';
import { createInitialStatus, assertTransition, sha256File, StatusStore } from './state.js';

/* ------------------------------------------------------------------ */
/* HeadlessRunner — claude -p en mode stream-json                      */
/* ------------------------------------------------------------------ */

export class HeadlessRunner implements RoleRunner {
  private readonly claudeBin: string;

  constructor(opts?: { claudeBin?: string }) {
    this.claudeBin = opts?.claudeBin ?? 'claude';
  }

  run(req: RoleRunRequest, onChunk: (chunk: RunnerChunk) => void): Promise<RoleRunResult> {
    // JAMAIS --dangerously-skip-permissions : la sandbox par rôle passe par --allowedTools.
    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      req.model,
      '--allowedTools',
      req.allowedTools.join(','),
    ];
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);

    return new Promise((resolve) => {
      let sessionId: string | null = null;
      let costUsd = 0;
      let resultText = '';
      let buffer = '';
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let hardKillTimer: NodeJS.Timeout | null = null;

      const settle = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolve({
          ok: exitCode === 0 && !timedOut,
          sessionId,
          costUsd,
          resultText,
          exitCode,
          timedOut,
        });
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.claudeBin, args, { cwd: req.cwd, env: process.env });
      } catch (err) {
        resolve({
          ok: false,
          sessionId: null,
          costUsd: 0,
          resultText: `spawn ${this.claudeBin} impossible : ${(err as Error).message}`,
          exitCode: -1,
          timedOut: false,
        });
        return;
      }

      // Timeout : SIGTERM, puis SIGKILL 5 s plus tard si le process s'accroche.
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, req.timeoutMs);

      const handleLine = (line: string): void => {
        const raw = line.trim();
        if (!raw) return;
        let parsed: Record<string, unknown> | null = null;
        try {
          const p = JSON.parse(raw) as unknown;
          parsed = p !== null && typeof p === 'object' ? (p as Record<string, unknown>) : null;
        } catch {
          parsed = null;
        }
        onChunk({ role: req.role, raw, parsed });
        if (parsed) {
          if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
          if (parsed.type === 'result') {
            // Ligne finale : coût réel + texte de résultat.
            if (typeof parsed.total_cost_usd === 'number') costUsd = parsed.total_cost_usd;
            else if (typeof parsed.cost_usd === 'number') costUsd = parsed.cost_usd;
            if (typeof parsed.result === 'string') resultText = parsed.result;
          }
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (data: string) => {
        buffer += data;
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handleLine(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      });
      child.stderr?.resume(); // drainé pour éviter le blocage du pipe
      child.on('error', () => settle(-1));
      child.on('close', (code) => {
        if (buffer.trim()) handleLine(buffer);
        settle(code ?? -1);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export interface OrchestratorOptions {
  repoDir: string;
  packageRoot: string;
  config: RoueConfig;
  runner: RoleRunner;
  gates: GateRunner;
  git: GitOps;
}

/** Stages depuis lesquels runCycle() a du travail à faire. */
const ACTIVE_STAGES: ReadonlySet<Stage> = new Set([
  'spec_locked',
  'coding',
  'gate_coder',
  'testing',
  'gate_tester',
]);

export class Orchestrator implements OrchestratorApi {
  private readonly opts: OrchestratorOptions;
  private readonly store: StatusStore;
  private config: RoueConfig;
  private status: StatusJson | null;
  private cycleRunning = false;
  private readonly eventListeners = new Set<(e: OrchestratorEvent) => void>();
  private readonly statusListeners = new Set<(s: StatusJson | null) => void>();

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.config = { ...opts.config };
    this.store = new StatusStore(path.join(opts.repoDir, STATUS_FILE));
    this.status = this.store.load();
  }

  /* ------------------------- chemins & helpers ------------------------- */

  private get specPath(): string {
    return path.join(this.opts.repoDir, SPEC_FILE);
  }

  private get eventsPath(): string {
    return path.join(this.opts.repoDir, EVENTS_FILE);
  }

  private taskBranch(): string {
    return `roue/${this.status!.task_id.slice(0, 8)}`;
  }

  /** Brief du rôle lu depuis les templates du package (repli minimal si absent). */
  private readRoleBrief(role: RoleName): string {
    const p = path.join(this.opts.packageRoot, 'templates', 'roles', `${role}.md`);
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return `# Rôle ${role}\nUn prompt reçu = un retour rendu. Exécute ta tâche, rends ton résultat, arrête-toi. Tu ne décides d'aucune transition.`;
    }
  }

  /* ------------------------ événements & statut ------------------------ */

  private emitEvent(type: EventType, role: RoleName | null, data: Record<string, unknown>): void {
    const event: OrchestratorEvent = {
      id: randomUUID(),
      at: new Date().toISOString(),
      type,
      role,
      stage: this.status?.stage ?? 'idle',
      iteration: this.status?.iteration ?? 1,
      data,
    };
    fs.mkdirSync(path.dirname(this.eventsPath), { recursive: true });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
    for (const l of this.eventListeners) l(event);
  }

  private notifyStatus(): void {
    for (const l of this.statusListeners) l(this.status);
  }

  /** Sauvegarde atomique + notification, pour les mutations SANS changement de stage. */
  private patch(partial: Partial<StatusJson>): void {
    if (!this.status) return;
    Object.assign(this.status, partial);
    this.store.save(this.status);
    this.notifyStatus();
  }

  /**
   * Voie UNIQUE de changement de stage : vérifie la table TRANSITIONS,
   * horodate, sauve atomiquement, émet l'événement et notifie.
   */
  private transition(to: Stage, extra?: Partial<StatusJson>): void {
    const st = this.status;
    if (!st) throw new Error('Aucune tâche : transition impossible.');
    const from = st.stage;
    assertTransition(from, to);
    if (extra) Object.assign(st, extra);
    st.stage = to;
    st.last_transition_at = new Date().toISOString();
    this.store.save(st);
    this.emitEvent('transition', null, { from, to });
    this.notifyStatus();
  }

  /** Étape reprenable correspondant à un stage actif (pour blocked_from). */
  private resumableFrom(stage: Stage): Stage {
    return stage === 'testing' || stage === 'gate_tester' ? 'testing' : 'coding';
  }

  /** Passage en blocked : motif + étape de reprise + alerte. */
  private block(reason: AlertType, from: Stage): void {
    const st = this.status;
    if (!st) return;
    st.blocked_reason = reason;
    st.blocked_from = from;
    this.transition('blocked');
    this.emitEvent('alert', null, { type: reason, from });
  }

  /* --------------------------- gardes objectives --------------------------- */

  /** Garde-fou 3 : spec figée. Hash modifié → blocked 'spec_altered'. */
  private guardSpec(): boolean {
    const st = this.status!;
    if (!st.spec_hash) return true;
    let current = '';
    try {
      current = sha256File(this.specPath);
    } catch {
      current = '';
    }
    if (current !== st.spec_hash) {
      this.block('spec_altered', this.resumableFrom(st.stage));
      return false;
    }
    return true;
  }

  /** Garde-fou 8 : budget en $. Dépassement → blocked 'budget'. */
  private guardBudget(): boolean {
    const st = this.status!;
    if (st.cost_usd_used > st.budget_usd) {
      this.block('budget', this.resumableFrom(st.stage));
      return false;
    }
    return true;
  }

  /* ----------------------------- exécution rôle ----------------------------- */

  private async runRole(
    role: RoleName,
    cwd: string,
    prompt: string,
  ): Promise<RoleRunResult | null> {
    const st = this.status!;
    const roleCfg = this.config.roles[role];
    // Le prompt EXACT est journalisé (source de la Timeline).
    this.emitEvent('prompt_sent', role, { prompt, cwd, model: roleCfg.model });
    const req: RoleRunRequest = {
      role,
      prompt,
      cwd,
      model: roleCfg.model,
      allowedTools: roleCfg.allowedTools,
      timeoutMs: st.timeout_minutes * 60_000,
      // Pas de --resume entre itérations : anti-dérive de contexte (garde-fou 7),
      // chaque run repart de la spec intégrale.
      resumeSessionId: null,
    };
    const result = await this.opts.runner.run(req, (chunk) =>
      this.emitEvent('chunk', role, { raw: chunk.raw, parsed: chunk.parsed }),
    );
    // Coût réel comptabilisé même si le run a échoué.
    this.patch({
      cost_usd_used: st.cost_usd_used + result.costUsd,
      sessions: { ...st.sessions, [role]: result.sessionId },
    });
    this.emitEvent('role_result', role, {
      ok: result.ok,
      cost_usd: result.costUsd,
      exit_code: result.exitCode,
      timed_out: result.timedOut,
      result_text: result.resultText,
      session_id: result.sessionId,
    });
    if (this.status?.stage === 'aborted') return null; // abort pendant le run
    if (result.timedOut) {
      // Garde-fou 4 : blocked doux, reprenable par retry().
      this.block('timeout', role === 'testeur' ? 'testing' : 'coding');
      return null;
    }
    return result;
  }

  /* ------------------------------ prompts rôle ------------------------------ */

  private readSpec(): string {
    return fs.readFileSync(this.specPath, 'utf8');
  }

  private buildCoderPrompt(): string {
    const st = this.status!;
    const parts = [
      this.readRoleBrief('coder'),
      `## Spec figée (INTÉGRALITÉ — jamais de résumé)\n\n${this.readSpec()}`,
      `## Itération\n${st.iteration}/${st.max_iterations}`,
    ];
    if (st.return_comment) {
      parts.push(`## Instruction figée de l'itération (renvoi)\n${st.return_comment}`);
    }
    return parts.join('\n\n');
  }

  private buildTesterPrompt(): string {
    const st = this.status!;
    return [
      this.readRoleBrief('testeur'),
      `## Spec figée (INTÉGRALITÉ — jamais de résumé)\n\n${this.readSpec()}`,
      `## Consigne\nTu es dans le worktree du testeur (branche de tâche ${this.taskBranch()}). ` +
        `Relis l'INTÉGRALITÉ du diff de la branche de tâche par rapport à la branche cible avant tout verdict. ` +
        `Ne crois pas le récit du coder : relance les tests à froid, vérifie que le diff correspond au périmètre de la spec, ` +
        `puis rédige un résumé factuel de ce que tu as vérifié (il servira de corps de PR).`,
      `## Itération\n${st.iteration}/${st.max_iterations}`,
    ].join('\n\n');
  }

  /* -------------------------------- la boucle -------------------------------- */

  /** Lance runCycle en arrière-plan, avec filet : crash → blocked + alerte. */
  private launchCycle(): void {
    void this.runCycle().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.emitEvent('alert', null, { type: 'crash', message });
      const st = this.status;
      // AlertType n'a pas de membre générique « erreur » : on retient
      // gate_failed_repeated comme motif de blocage le moins faux.
      if (st && (TRANSITIONS[st.stage] ?? []).includes('blocked')) {
        try {
          this.block('gate_failed_repeated', this.resumableFrom(st.stage));
        } catch {
          /* déjà terminal */
        }
      }
    });
  }

  /**
   * Boucle `while` sur le stage courant (et non séquence linéaire) : elle sait
   * reprendre depuis coding (returnToCoder/retry) ou testing. Elle rend la main
   * dès qu'on atteint review / blocked / aborted.
   */
  private async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    this.cycleRunning = true;
    try {
      // La branche cible est écrite dans un fichier lu par les gates :
      // l'interface GateRunner.run(gate, cwd) est figée, on ne peut pas passer
      // d'env par appel — les gates la retrouvent via git rev-parse --git-common-dir.
      try {
        const target = await this.opts.git.targetBranch();
        fs.mkdirSync(path.join(this.opts.repoDir, ORCH_DIR), { recursive: true });
        fs.writeFileSync(path.join(this.opts.repoDir, ORCH_DIR, 'target-branch'), `${target}\n`);
      } catch {
        /* best effort — les gates retombent sur main */
      }

      while (true) {
        const st = this.status;
        if (!st || !ACTIVE_STAGES.has(st.stage)) return;

        // Gardes objectives AVANT chaque étape (spec_locked passe immédiatement
        // en coding ; ses gardes s'appliquent donc au tour suivant, avant tout travail).
        if (st.stage !== 'spec_locked') {
          if (!this.guardSpec()) return;
          if (!this.guardBudget()) return;
        }

        const branch = this.taskBranch();

        switch (st.stage) {
          case 'spec_locked': {
            this.transition('coding');
            break;
          }

          case 'coding': {
            const cwd = await this.opts.git.ensureWorktree('coder', branch);
            const result = await this.runRole('coder', cwd, this.buildCoderPrompt());
            if (!result) return; // timeout (blocked) ou abort
            if (this.status?.stage !== 'coding') return; // abort concurrent
            this.transition('gate_coder');
            break;
          }

          case 'gate_coder': {
            const cwd = await this.opts.git.ensureWorktree('coder', branch);
            const res = await this.opts.gates.run('coder', cwd);
            if (this.status?.stage !== 'gate_coder') return;
            this.patch({ gates: { ...st.gates, coder: res } });
            if (res.ok) {
              this.emitEvent('gate_passed', 'coder', { gate: res });
              this.transition('testing');
            } else {
              this.emitEvent('gate_failed', 'coder', { gate: res });
              const iteration = st.iteration + 1;
              this.patch({ iteration });
              if (iteration > st.max_iterations) {
                this.block('loop', 'coding');
                return;
              }
              this.transition('coding');
            }
            break;
          }

          case 'testing': {
            const cwd = await this.opts.git.ensureWorktree('testeur', branch);
            const result = await this.runRole('testeur', cwd, this.buildTesterPrompt());
            if (!result) return;
            if (this.status?.stage !== 'testing') return;
            this.patch({ tester_summary: result.resultText });
            this.transition('gate_tester');
            break;
          }

          case 'gate_tester': {
            const cwd = await this.opts.git.ensureWorktree('testeur', branch);
            const res = await this.opts.gates.run('tester', cwd);
            if (this.status?.stage !== 'gate_tester') return;
            this.patch({ gates: { ...st.gates, tester: res } });
            if (res.ok) {
              this.emitEvent('gate_passed', 'testeur', { gate: res });
              const title = st.description.length > 70 ? `${st.description.slice(0, 67)}…` : st.description;
              const prUrl = await this.opts.git.createPr(branch, title, st.tester_summary ?? '');
              // FIN de boucle : on attend l'action utilisateur (merge / return / abort).
              this.transition('review', { pr_url: prUrl });
              return;
            }
            this.emitEvent('gate_failed', 'testeur', { gate: res });
            const iteration = st.iteration + 1;
            this.patch({ iteration });
            if (iteration > st.max_iterations) {
              this.block('loop', 'coding');
              return;
            }
            // L'extrait des logs de gate informe l'itération suivante du coder.
            const excerpt = `${res.stdout}\n${res.stderr}`.trim().slice(-2000);
            this.patch({
              return_comment: `Gate testeur échouée (exit ${res.exit_code}). Extrait des logs :\n${excerpt}`,
            });
            this.transition('coding');
            break;
          }

          default:
            return;
        }
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  /* ------------------------------ OrchestratorApi ------------------------------ */

  /** Reprise au démarrage de la CLI : une tâche en attente relance son cycle. */
  async start(): Promise<void> {
    this.status = this.store.load();
    const st = this.status;
    if (st && ['spec_locked', 'coding', 'testing'].includes(st.stage)) {
      this.launchCycle();
    }
  }

  getStatus(): StatusJson | null {
    return this.status;
  }

  async getEvents(limit = 200): Promise<OrchestratorEvent[]> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.eventsPath, 'utf8');
    } catch {
      return [];
    }
    const events: OrchestratorEvent[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as OrchestratorEvent);
      } catch {
        /* ligne corrompue ignorée */
      }
    }
    return events.slice(-limit);
  }

  getConfig(): RoueConfig {
    return this.config;
  }

  /** Fusion superficielle + persistance dans .orchestration/config.json. */
  async setConfig(patch: Partial<RoueConfig>): Promise<RoueConfig> {
    this.config = { ...this.config, ...patch };
    const p = path.join(this.opts.repoDir, LOCAL_CONFIG_FILE);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(this.config, null, 2));
    return this.config;
  }

  /** Crée la tâche : le prompteur génère la spec (aperçu, pas encore verrouillée). */
  async createTask(req: TaskCreateRequest): Promise<{ spec_preview: string }> {
    const existing = this.store.load() ?? this.status;
    if (existing && !['idle', 'merged', 'aborted'].includes(existing.stage)) {
      throw new Error(
        `Une tâche est déjà en cours (stage ${existing.stage}) — abandonne-la avant d'en créer une autre.`,
      );
    }
    if (!req.success_criterion?.trim()) {
      throw new Error('Le critère de succès est obligatoire.');
    }
    const project = req.project?.trim() || path.basename(this.opts.repoDir);
    this.status = createInitialStatus({
      taskId: randomUUID(),
      project,
      risk: req.risk_level,
      description: req.description,
      successCriterion: req.success_criterion,
      config: this.config,
    });
    this.store.save(this.status);
    this.notifyStatus();

    // Génération de la spec par le rôle prompteur (lecture seule sur le code).
    const prompt = [
      this.readRoleBrief('prompteur'),
      `## Demande\n${req.description}`,
      `## Critère de succès (vérifiable)\n${req.success_criterion}`,
      `## Projet\n${project}`,
    ].join('\n\n');
    const result = await this.runRole('prompteur', this.opts.repoDir, prompt);
    if (!result || !result.ok || !result.resultText.trim()) {
      throw new Error(
        `Le prompteur n'a pas produit de spec (exit ${result?.exitCode ?? '?'}, timeout ${result ? String(result.timedOut) : '?'}).`,
      );
    }
    fs.mkdirSync(path.dirname(this.specPath), { recursive: true });
    fs.writeFileSync(this.specPath, result.resultText);
    this.emitEvent('task_created', null, {
      task_id: this.status.task_id,
      description: req.description,
      success_criterion: req.success_criterion,
      risk_level: req.risk_level,
      project,
    });
    return { spec_preview: result.resultText };
  }

  /** Verrouille la spec (hash) et démarre le cycle en arrière-plan. */
  async confirmTask(): Promise<void> {
    const st = this.status;
    if (!st) throw new Error('Aucune tâche à confirmer.');
    if (st.stage !== 'idle') throw new Error(`confirmTask impossible depuis ${st.stage}.`);
    if (!fs.existsSync(this.specPath)) throw new Error('spec.md absente — génère la spec d\'abord.');
    const specHash = sha256File(this.specPath);
    this.transition('spec_locked', { spec_hash: specHash });
    this.emitEvent('spec_locked', null, { spec_hash: specHash });
    this.launchCycle();
  }

  /** Garde-fou 5 : le merge ne passe QUE par ici (bouton dashboard). */
  async merge(): Promise<void> {
    const st = this.status;
    if (!st || st.stage !== 'review') {
      throw new Error(`Merge impossible : stage ${st?.stage ?? 'absent'} (review requis).`);
    }
    if (!st.pr_url) throw new Error('Aucune PR à merger.');
    await this.opts.git.mergePr(st.pr_url);
    this.transition('merged');
    this.emitEvent('merge', null, { pr_url: st.pr_url });
  }

  /** Renvoi au coder : le commentaire devient instruction figée de l'itération suivante. */
  async returnToCoder(comment: string): Promise<void> {
    const st = this.status;
    if (!st || st.stage !== 'review') {
      throw new Error(`Renvoi impossible : stage ${st?.stage ?? 'absent'} (review requis).`);
    }
    const iteration = st.iteration + 1;
    this.patch({ return_comment: comment, iteration });
    this.emitEvent('return_to_coder', null, { comment, iteration });
    // review→blocked n'existe pas dans TRANSITIONS : on repasse par coding,
    // puis on bloque immédiatement si le plafond d'itérations est dépassé.
    this.transition('coding');
    if (iteration > st.max_iterations) {
      this.block('loop', 'coding');
      return;
    }
    this.launchCycle();
  }

  /** Abandon utilisateur, depuis tout stage non terminal. */
  async abort(): Promise<void> {
    const st = this.status;
    if (!st) throw new Error('Aucune tâche à abandonner.');
    if (st.stage === 'merged' || st.stage === 'aborted') {
      throw new Error(`Tâche déjà terminale (${st.stage}).`);
    }
    this.transition('aborted');
    this.emitEvent('abort', null, { from: st.stage });
    try {
      await this.opts.git.removeWorktrees();
    } catch {
      /* best effort */
    }
  }

  /** Depuis blocked : relance depuis l'étape bloquée (blocked doux). */
  async retry(): Promise<void> {
    const st = this.status;
    if (!st || st.stage !== 'blocked') {
      throw new Error(`Retry impossible : stage ${st?.stage ?? 'absent'} (blocked requis).`);
    }
    const candidate = st.blocked_from;
    const to: Stage =
      candidate && TRANSITIONS.blocked.includes(candidate) ? candidate : 'coding';
    this.transition(to, { blocked_reason: null, blocked_from: null });
    this.launchCycle();
  }

  async getDiff(): Promise<DiffReview> {
    const st = this.status;
    let diff = '';
    if (st) {
      try {
        diff = await this.opts.git.diffAgainstTarget(this.taskBranch());
      } catch {
        diff = '';
      }
    }
    return {
      diff,
      tester_summary: st?.tester_summary ?? '',
      gate_tester: st?.gates.tester ?? null,
      pr_url: st?.pr_url ?? null,
    };
  }

  onEvent(listener: (e: OrchestratorEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (s: StatusJson | null) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
}
