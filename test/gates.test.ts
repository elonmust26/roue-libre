/**
 * Tests de ShellGateRunner (src/core/gates.ts) : exécution réelle de scripts
 * bash temporaires — seule voie de transition de la machine d'états.
 * bash est disponible partout où roue-libre tourne (Git Bash sous Windows,
 * natif sur macOS/Linux).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ShellGateRunner } from '../src/core/gates.js';

let packageRoot: string;
let cwdCible: string;

/** Écrit un script bash exécutable (LF) dans le faux packageRoot. */
function ecrireScript(nom: string, contenu: string): void {
  const chemin = path.join(packageRoot, 'gates', nom);
  fs.writeFileSync(chemin, contenu, { encoding: 'utf8' });
  // chmod sans effet sous Windows, requis sur macOS/Linux si le runner exécute le fichier.
  fs.chmodSync(chemin, 0o755);
}

beforeAll(() => {
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-'));
  cwdCible = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-'));
  fs.mkdirSync(path.join(packageRoot, 'gates'));

  ecrireScript('ok.sh', '#!/usr/bin/env bash\necho "gate coder : diff non vide, typecheck OK, tests OK"\nexit 0\n');
  ecrireScript(
    'ko.sh',
    '#!/usr/bin/env bash\necho "sortie standard avant échec"\necho "1 test échoué : demo.txt ne contient pas OK" >&2\nexit 3\n',
  );
  ecrireScript('env.sh', '#!/usr/bin/env bash\necho "probe=$ROUE_PROBE"\nexit 0\n');
});

describe('ShellGateRunner', () => {
  it('gate qui sort en exit 0 → GateResult ok:true avec stdout capturé', async () => {
    const runner = new ShellGateRunner({
      packageRoot,
      scripts: { coder: 'gates/ok.sh', tester: 'gates/ko.sh' },
    });

    const res = await runner.run('coder', cwdCible);

    expect(res.ok).toBe(true);
    expect(res.exit_code).toBe(0);
    expect(res.name).toBe('coder');
    expect(res.stdout).toContain('diff non vide');
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(res.at))).toBe(true);
  });

  it('gate qui sort en exit 3 → ok:false, exit_code 3, stderr capturé — jamais de throw', async () => {
    const runner = new ShellGateRunner({
      packageRoot,
      scripts: { coder: 'gates/ok.sh', tester: 'gates/ko.sh' },
    });

    const res = await runner.run('tester', cwdCible);

    expect(res.ok).toBe(false);
    expect(res.exit_code).toBe(3);
    expect(res.name).toBe('tester');
    expect(res.stdout).toContain('sortie standard avant échec');
    expect(res.stderr).toContain('demo.txt ne contient pas OK');
    expect(Number.isFinite(Date.parse(res.at))).toBe(true);
  });

  it("transmet l'environnement fourni au script de gate", async () => {
    const runner = new ShellGateRunner({
      packageRoot,
      scripts: { coder: 'gates/env.sh', tester: 'gates/ko.sh' },
      env: { ROUE_PROBE: '42' },
    });

    const res = await runner.run('coder', cwdCible);

    expect(res.ok).toBe(true);
    expect(res.stdout).toContain('probe=42');
  });
});
