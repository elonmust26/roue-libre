/**
 * Opérations git réelles : worktrees par rôle, diff, PR via gh.
 * Tout passe par execFile (jamais de shell interpolé).
 * Aucun force-push, aucune suppression destructrice hors worktrees de la tâche.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { WORKTREES_DIR, type GitOps, type RoleName } from './types.js';

const execFileAsync = promisify(execFile);
/** Les diffs peuvent être volumineux. */
const MAX_BUFFER = 32 * 1024 * 1024;

export class RealGitOps implements GitOps {
  private readonly repoDir: string;
  /** Conservé pour traçabilité (nommage/diagnostic) — la branche est calculée par le moteur. */
  private readonly taskId: string;

  constructor(opts: { repoDir: string; taskId: string }) {
    this.repoDir = opts.repoDir;
    this.taskId = opts.taskId;
  }

  private async exec(bin: string, args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync(bin, args, {
      cwd: cwd ?? this.repoDir,
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Worktree par rôle sous .orchestration/worktrees/<role>.
   * Le coder possède la branche de tâche (checkout classique). Les autres rôles
   * sont DÉTACHÉS sur la pointe de la branche : git refuse deux checkouts de la
   * même branche, et le testeur n'a de toute façon pas à écrire dessus.
   */
  async ensureWorktree(role: RoleName, branch: string): Promise<string> {
    const wtPath = path.resolve(this.repoDir, WORKTREES_DIR, role);
    const exists = await this.branchExists(branch);

    if (fs.existsSync(wtPath)) {
      // Worktree déjà présent : on rafraîchit la pointe pour les rôles détachés
      // (le coder a pu commiter depuis la dernière itération).
      if (role !== 'coder' && exists) {
        try {
          await this.exec('git', ['checkout', '--detach', branch], wtPath);
        } catch {
          /* best effort — le worktree reste utilisable */
        }
      }
      return wtPath;
    }

    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    if (role === 'coder') {
      if (exists) {
        await this.exec('git', ['worktree', 'add', wtPath, branch]);
      } else {
        await this.exec('git', ['worktree', 'add', wtPath, '-b', branch]);
      }
    } else if (exists) {
      await this.exec('git', ['worktree', 'add', '--detach', wtPath, branch]);
    } else {
      // Cas dégradé (branche pas encore créée) : détaché sur HEAD courant.
      await this.exec('git', ['worktree', 'add', '--detach', wtPath]);
    }
    return wtPath;
  }

  /** Branche cible = branche courante du repo principal. */
  async targetBranch(): Promise<string> {
    const out = await this.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    return out.trim();
  }

  /** Diff unifié branche de tâche vs branche cible (triple point : depuis l'ancêtre commun). */
  async diffAgainstTarget(branch: string): Promise<string> {
    const target = await this.targetBranch();
    return this.exec('git', ['diff', `${target}...${branch}`]);
  }

  /** Push de la branche puis ouverture de la PR via gh. Retourne l'URL. */
  async createPr(branch: string, title: string, body: string): Promise<string> {
    await this.exec('git', ['push', '-u', 'origin', branch]);
    const out = await this.exec('gh', [
      'pr',
      'create',
      '--title',
      title,
      '--body',
      body,
      '--head',
      branch,
    ]);
    const urls = out.match(/https:\/\/\S+/g);
    return urls ? urls[urls.length - 1] : out.trim();
  }

  /** Merge de la PR — appelé UNIQUEMENT par l'action dashboard (garde-fou 5). */
  async mergePr(url: string): Promise<void> {
    await this.exec('gh', ['pr', 'merge', url, '--squash']);
  }

  /** Nettoyage best effort des worktrees de la tâche, puis prune. */
  async removeWorktrees(): Promise<void> {
    const dir = path.resolve(this.repoDir, WORKTREES_DIR);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        const wtPath = path.join(dir, entry);
        try {
          await this.exec('git', ['worktree', 'remove', '--force', wtPath]);
        } catch {
          try {
            fs.rmSync(wtPath, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
      }
    }
    try {
      await this.exec('git', ['worktree', 'prune']);
    } catch {
      /* best effort */
    }
  }
}
