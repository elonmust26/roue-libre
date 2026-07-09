/**
 * Exécution des gates shell — seule voie de transition de la machine d'états.
 * Un exit code ≠ 0 est un RÉSULTAT (GateResult.ok = false), jamais une exception.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { GateResult, GateRunner } from './types.js';

/** Troncature des sorties capturées (~64 Ko chacune). */
const MAX_CAPTURE = 64 * 1024;
/** Timeout dur d'une gate : 15 minutes. */
const GATE_TIMEOUT_MS = 15 * 60 * 1000;

function truncate(s: string): string {
  return s.length > MAX_CAPTURE ? `${s.slice(0, MAX_CAPTURE)}\n…[tronqué]` : s;
}

export class ShellGateRunner implements GateRunner {
  private readonly packageRoot: string;
  private readonly scripts: { coder: string; tester: string };
  private readonly env: Record<string, string>;

  constructor(opts: {
    packageRoot: string;
    scripts: { coder: string; tester: string };
    env?: Record<string, string>;
  }) {
    this.packageRoot = opts.packageRoot;
    this.scripts = opts.scripts;
    this.env = opts.env ?? {};
  }

  run(gate: 'coder' | 'tester', cwd: string): Promise<GateResult> {
    const rel = this.scripts[gate];
    let scriptPath = path.isAbsolute(rel) ? rel : path.resolve(this.packageRoot, rel);
    // Git Bash (Windows) digère mieux les chemins à slashes.
    if (process.platform === 'win32') scriptPath = scriptPath.replace(/\\/g, '/');

    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | null = null;
      let hardKillTimer: NodeJS.Timeout | null = null;

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        if (hardKillTimer) clearTimeout(hardKillTimer);
        resolve({
          name: gate,
          ok: exitCode === 0 && !timedOut,
          exit_code: exitCode,
          duration_ms: Date.now() - started,
          stdout: truncate(stdout),
          stderr: truncate(
            timedOut ? `${stderr}\n[gate ${gate}] timeout 15 min — processus tué` : stderr,
          ),
          at: new Date().toISOString(),
        });
      };

      let child: ReturnType<typeof spawn>;
      try {
        // Les gates s'exécutent via bash (Git Bash sous Windows, bash natif ailleurs).
        child = spawn('bash', [scriptPath], {
          cwd,
          env: { ...process.env, ...this.env },
        });
      } catch (err) {
        stderr = `spawn bash impossible : ${(err as Error).message}`;
        finish(-1);
        return;
      }

      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }, GATE_TIMEOUT_MS);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        if (stdout.length <= MAX_CAPTURE) stdout += d;
      });
      child.stderr?.on('data', (d: string) => {
        if (stderr.length <= MAX_CAPTURE) stderr += d;
      });
      child.on('error', (err) => {
        stderr += `\nspawn bash : ${err.message}`;
        finish(-1);
      });
      child.on('close', (code) => finish(code ?? -1));
    });
  }
}
