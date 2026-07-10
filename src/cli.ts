/**
 * CLI roue — commandes : init / task / start / status.
 * Parsing via node:util parseArgs, zéro dépendance externe.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  EVENTS_FILE,
  LOCAL_CONFIG_FILE,
  ORCH_DIR,
  SPEC_FILE,
  STATUS_FILE,
  type GateRunner,
  type GateResult,
  type GitOps,
  type OrchestratorEvent,
  type EventType,
  type RiskLevel,
  type RoleRunner,
  type RoueConfig,
  type ServerHandle,
  type ServerOptions,
  type StatusJson,
} from './core/types.js';
import { assertTransition, createInitialStatus, sha256File, StatusStore } from './core/state.js';
import { ShellGateRunner } from './core/gates.js';
import { HeadlessRunner, Orchestrator } from './core/engine.js';
import { RealGitOps } from './core/git.js';
import { checkCliVersion, TESTED_CLI_VERSION } from './core/cliversion.js';

/** Racine du package : dist/cli.js → dossier parent de dist/. */
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fail(message: string): never {
  console.error(`roue : ${message}`);
  process.exit(1);
}

function readJsonIfExists(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Config du package : DEFAULT_CONFIG fusionné avec roue.config.json du package. */
function loadPackageConfig(): RoueConfig {
  const fromPackage = readJsonIfExists(path.join(packageRoot, 'roue.config.json'));
  return { ...DEFAULT_CONFIG, ...(fromPackage ?? {}) } as RoueConfig;
}

/** Config effective : fichier local .orchestration/config.json > roue.config.json > défauts. */
function loadConfig(repoDir: string): RoueConfig {
  const local = readJsonIfExists(path.join(repoDir, LOCAL_CONFIG_FILE));
  return { ...loadPackageConfig(), ...(local ?? {}) } as RoueConfig;
}

/** Projet auto-détecté : remote origin (basename sans .git), sinon nom du dossier. */
function detectProject(repoDir: string): string {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'], // stderr muet : l'absence de remote est un cas normal
    }).trim();
    const base = url.split('/').pop() ?? '';
    const name = base.replace(/\.git$/, '').trim();
    if (name) return name;
  } catch {
    /* pas de remote — repli sur le dossier */
  }
  return path.basename(repoDir);
}

/** Append NDJSON dans events.ndjson (même format que le moteur). */
function appendEvent(
  repoDir: string,
  status: StatusJson,
  type: EventType,
  data: Record<string, unknown>,
): void {
  const event: OrchestratorEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type,
    role: null,
    stage: status.stage,
    iteration: status.iteration,
    data,
  };
  const p = path.join(repoDir, EVENTS_FILE);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${JSON.stringify(event)}\n`);
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* best effort — l'URL est affichée dans le terminal */
  }
}

/** Gabarit de repli si templates/spec.md manque dans le package. */
const FALLBACK_SPEC_TEMPLATE = `# Spec figée — {{TASK_ID}}

- Projet : {{PROJECT}}
- Date : {{DATE}}
- Risque : {{RISK}}

## Objectif

{{DESCRIPTION}}

## Critère de succès (vérifiable)

{{SUCCESS_CRITERION}}

## Hors périmètre

Tout ce qui n'est pas explicitement décrit ci-dessus.
`;

/* ------------------------------------------------------------------ */
/* roue init                                                           */
/* ------------------------------------------------------------------ */

function cmdInit(): void {
  const repoDir = process.cwd();
  const orchDir = path.join(repoDir, ORCH_DIR);
  fs.mkdirSync(orchDir, { recursive: true });

  // Gabarit de spec copié dans le repo cible (référence pour l'utilisateur).
  const specTpl = path.join(packageRoot, 'templates', 'spec.md');
  const specTplDest = path.join(orchDir, 'spec.template.md');
  if (!fs.existsSync(specTplDest)) {
    if (fs.existsSync(specTpl)) {
      fs.copyFileSync(specTpl, specTplDest);
    } else {
      fs.writeFileSync(specTplDest, FALLBACK_SPEC_TEMPLATE);
    }
  }

  // Config locale : défauts du package, jamais écrasée si déjà présente (idempotence).
  const cfgDest = path.join(repoDir, LOCAL_CONFIG_FILE);
  if (!fs.existsSync(cfgDest)) {
    fs.writeFileSync(cfgDest, JSON.stringify(loadPackageConfig(), null, 2));
  }

  // CLAUDE.md du repo cible : copie directe, ou CLAUDE.roue.md si un CLAUDE.md existe.
  const claudeTpl = path.join(packageRoot, 'templates', 'CLAUDE.target.md');
  if (fs.existsSync(claudeTpl)) {
    const claudeDest = path.join(repoDir, 'CLAUDE.md');
    if (fs.existsSync(claudeDest)) {
      const side = path.join(repoDir, 'CLAUDE.roue.md');
      if (!fs.existsSync(side)) fs.copyFileSync(claudeTpl, side);
      console.log(
        'CLAUDE.md existe déjà → CLAUDE.roue.md écrit à côté. Fusionne-le manuellement dans ton CLAUDE.md.',
      );
    } else {
      fs.copyFileSync(claudeTpl, claudeDest);
      console.log('CLAUDE.md installé dans le repo cible.');
    }
  } else {
    console.warn('templates/CLAUDE.target.md absent du package — étape ignorée.');
  }

  // .orchestration/ ne doit jamais être versionné dans le repo cible.
  const gitignore = path.join(repoDir, '.gitignore');
  const current = fs.existsSync(gitignore) ? fs.readFileSync(gitignore, 'utf8') : '';
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  if (!lines.includes('.orchestration/') && !lines.includes('.orchestration')) {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(gitignore, `${current}${sep}.orchestration/\n`);
    console.log('.orchestration/ ajouté au .gitignore.');
  }

  console.log(`roue init : ${orchDir} prêt.`);
}

/* ------------------------------------------------------------------ */
/* roue task                                                           */
/* ------------------------------------------------------------------ */

function cmdTask(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      success: { type: 'string' },
      risk: { type: 'string' },
      project: { type: 'string' },
    },
    allowPositionals: true,
  });

  const description = positionals[0];
  if (!description || !description.trim()) {
    fail('usage : roue task "description" --success "critère" [--risk low|medium|high] [--project nom]');
  }
  if (!values.success || !values.success.trim()) {
    fail('le critère de succès est OBLIGATOIRE : --success "critère vérifiable"');
  }

  const repoDir = process.cwd();
  const config = loadConfig(repoDir);
  const risk = (values.risk ?? config.default_risk) as RiskLevel;
  if (!['low', 'medium', 'high'].includes(risk)) {
    fail(`risque invalide « ${risk} » (attendu : low | medium | high)`);
  }
  const project = values.project?.trim() || detectProject(repoDir);

  const store = new StatusStore(path.join(repoDir, STATUS_FILE));
  const existing = store.load();
  if (existing && !['idle', 'merged', 'aborted'].includes(existing.stage)) {
    fail(`une tâche est déjà en cours (stage ${existing.stage}) — abandonne-la d'abord.`);
  }

  // Génération DÉTERMINISTE de la spec (zéro token) depuis le gabarit du package.
  const tplPath = path.join(packageRoot, 'templates', 'spec.md');
  const template = fs.existsSync(tplPath)
    ? fs.readFileSync(tplPath, 'utf8')
    : FALLBACK_SPEC_TEMPLATE;
  const taskId = randomUUID();
  const spec = template
    .replaceAll('{{TASK_ID}}', taskId)
    .replaceAll('{{PROJECT}}', project)
    .replaceAll('{{DATE}}', new Date().toISOString().slice(0, 10))
    .replaceAll('{{DESCRIPTION}}', description.trim())
    .replaceAll('{{SUCCESS_CRITERION}}', values.success.trim())
    .replaceAll('{{RISK}}', risk);

  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const specPath = path.join(repoDir, SPEC_FILE);
  fs.writeFileSync(specPath, spec);

  const status = createInitialStatus({
    taskId,
    project,
    risk,
    description: description.trim(),
    successCriterion: values.success.trim(),
    config,
  });
  store.save(status);
  appendEvent(repoDir, status, 'task_created', {
    task_id: taskId,
    description: description.trim(),
    success_criterion: values.success.trim(),
    risk_level: risk,
    project,
  });

  // Verrouillage immédiat : hash + transition idle→spec_locked.
  status.spec_hash = sha256File(specPath);
  assertTransition(status.stage, 'spec_locked');
  const from = status.stage;
  status.stage = 'spec_locked';
  status.last_transition_at = new Date().toISOString();
  store.save(status);
  appendEvent(repoDir, status, 'transition', { from, to: 'spec_locked' });
  appendEvent(repoDir, status, 'spec_locked', { spec_hash: status.spec_hash });

  console.log('Tâche créée et spec verrouillée :');
  console.log(`  tâche   : ${taskId}`);
  console.log(`  projet  : ${project} (risque ${risk})`);
  console.log(`  spec    : ${specPath}`);
  console.log(`  critère : ${values.success.trim()}`);
  console.log(`  budget  : $${status.budget_usd.toFixed(2)} — ${status.max_iterations} itérations max`);
  console.log('Lance `roue start` (ou `roue start --simulate`) pour dérouler le cycle.');
}

/* ------------------------------------------------------------------ */
/* roue start                                                          */
/* ------------------------------------------------------------------ */

async function cmdStart(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      simulate: { type: 'boolean', default: false },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
    },
  });

  const repoDir = process.cwd();
  const config = loadConfig(repoDir);
  const port = values.port !== undefined ? Number(values.port) : config.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    fail(`port invalide : ${values.port}`);
  }

  let runner: RoleRunner;
  let gates: GateRunner;
  let git: GitOps;
  if (values.simulate) {
    // Mode simulation : zéro token, stubs à fixtures écrits dans src/sim/.
    const sim = await import('./sim/runner.js');
    runner = new sim.SimulatedRunner();
    gates = new sim.SimulatedGateRunner();
    git = new sim.SimulatedGitOps();
  } else {
    // v0.2 — vérification de version CLI : avertit sans bloquer si la version
    // installée s'éloigne de celle testée en dev (format stream-json).
    const check = checkCliVersion();
    if (check.detected) {
      console.log(`CLI claude : ${check.detected} (testée en dev : ${TESTED_CLI_VERSION})`);
    }
    if (check.warning) {
      console.warn(`⚠ ${check.warning}`);
    }
    runner = new HeadlessRunner();
    gates = new ShellGateRunner({ packageRoot, scripts: config.gates, env: {} });
    const existing = new StatusStore(path.join(repoDir, STATUS_FILE)).load();
    git = new RealGitOps({ repoDir, taskId: existing?.task_id ?? '' });
  }

  const orchestrator = new Orchestrator({
    repoDir,
    packageRoot,
    config: { ...config, port },
    runner,
    gates,
    git,
  });

  const { startServer } = (await import('./server/index.js')) as {
    startServer: (opts: ServerOptions) => Promise<ServerHandle>;
  };
  const handle = await startServer({
    port,
    orchestrator,
    dashboardDist: path.join(packageRoot, 'dashboard', 'dist'),
  });

  // Reprise automatique du cycle si une tâche attend (spec_locked/coding/testing).
  await orchestrator.start();

  const url = `http://localhost:${handle.port}`;
  const st = orchestrator.getStatus();
  console.log(`roue start — mode ${values.simulate ? 'SIMULATION (zéro token)' : 'réel'}`);
  console.log(`dashboard : ${url}`);
  console.log(
    st
      ? `état : ${st.stage} — itération ${st.iteration}/${st.max_iterations} — $${st.cost_usd_used.toFixed(2)}/$${st.budget_usd.toFixed(2)}`
      : 'état : idle — aucune tâche',
  );
  if (!values['no-open']) openBrowser(url);
  // Le serveur HTTP tient le process vivant — rien d'autre à faire ici.
}

/* ------------------------------------------------------------------ */
/* roue status                                                         */
/* ------------------------------------------------------------------ */

function cmdStatus(): void {
  const store = new StatusStore(path.join(process.cwd(), STATUS_FILE));
  const st = store.load();
  if (!st) {
    console.log('idle — aucune tâche');
    return;
  }
  const gate = (g: GateResult | null): string =>
    g ? (g.ok ? 'OK' : `ÉCHEC (exit ${g.exit_code})`) : '—';
  console.log(`tâche     : ${st.task_id}`);
  console.log(`projet    : ${st.project} (risque ${st.risk_level})`);
  console.log(`stage     : ${st.stage}`);
  console.log(`itération : ${st.iteration}/${st.max_iterations}`);
  console.log(`budget    : $${st.cost_usd_used.toFixed(2)} / $${st.budget_usd.toFixed(2)}`);
  console.log(`gates     : coder ${gate(st.gates.coder)} | tester ${gate(st.gates.tester)}`);
  if (st.pr_url) console.log(`PR        : ${st.pr_url}`);
  if (st.stage === 'blocked') {
    console.log(`blocage   : ${st.blocked_reason ?? '?'} (reprise depuis ${st.blocked_from ?? 'coding'})`);
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const HELP = `roue — orchestrateur local multi-Claude Code

Usage :
  roue init                                        Prépare .orchestration/ dans le repo cible
  roue task "description" --success "critère"      Crée une tâche (spec figée immédiatement)
            [--risk low|medium|high] [--project n]
  roue start [--simulate] [--port N] [--no-open]   Lance serveur + dashboard (+ reprise du cycle)
  roue status                                      État courant en terminal
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      cmdInit();
      break;
    case 'task':
      cmdTask(rest);
      break;
    case 'start':
      await cmdStart(rest);
      break;
    case 'status':
      cmdStatus();
      break;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;
    default:
      fail(`commande inconnue « ${command} »\n\n${HELP}`);
  }
}

main().catch((err) => {
  console.error(`roue : ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
