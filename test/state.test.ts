/**
 * Tests unitaires de la machine d'états (src/core/state.ts).
 * Contrat : createInitialStatus, assertTransition, StatusStore (écriture
 * atomique tmp + rename), sha256File.
 */

import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StatusStore, assertTransition, createInitialStatus, sha256File } from '../src/core/state.js';
import { DEFAULT_CONFIG, EVENTS_FILE, SPEC_FILE, TRANSITIONS } from '../src/core/types.js';
import type { Stage, StatusJson } from '../src/core/types.js';

function dossierTemp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'roue-'));
}

function statutDeTest(): StatusJson {
  return createInitialStatus({
    taskId: 'tache-test-1',
    project: 'roue-demo',
    risk: 'low',
    description: 'démo',
    successCriterion: 'le fichier demo.txt contient OK',
    config: DEFAULT_CONFIG,
  });
}

describe('createInitialStatus', () => {
  it('produit un StatusJson initial conforme au contrat', () => {
    const s = statutDeTest();

    expect(s.task_id).toBe('tache-test-1');
    expect(s.project).toBe('roue-demo');
    expect(s.risk_level).toBe('low');
    expect(s.description).toBe('démo');
    expect(s.success_criterion).toBe('le fichier demo.txt contient OK');

    // État de départ : idle, première itération, rien de consommé.
    expect(s.stage).toBe('idle');
    expect(s.iteration).toBe(1);
    expect(s.cost_usd_used).toBe(0);

    // Seuils repris de la config.
    expect(s.max_iterations).toBe(DEFAULT_CONFIG.max_iterations);
    expect(s.budget_usd).toBe(DEFAULT_CONFIG.budget_usd);
    expect(s.timeout_minutes).toBe(DEFAULT_CONFIG.timeout_minutes);

    // Chemins canoniques.
    expect(s.spec_path).toBe(SPEC_FILE);
    expect(s.history_file).toBe(EVENTS_FILE);

    // Rien de verrouillé / bloqué / produit au départ.
    expect(s.spec_hash).toBeNull();
    expect(s.blocked_reason).toBeNull();
    expect(s.blocked_from).toBeNull();
    expect(s.tester_summary).toBeNull();
    expect(s.return_comment).toBeNull();
    expect(s.pr_url).toBeNull();
    expect(s.sessions).toEqual({ prompteur: null, coder: null, testeur: null });
    expect(s.gates).toEqual({ coder: null, tester: null });

    // Horodatage ISO valide.
    expect(Number.isFinite(Date.parse(s.last_transition_at))).toBe(true);
  });
});

describe('assertTransition', () => {
  it('accepte chaque transition déclarée dans TRANSITIONS', () => {
    for (const [from, tos] of Object.entries(TRANSITIONS) as Array<[Stage, Stage[]]>) {
      for (const to of tos) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('jette sur des transitions interdites', () => {
    const interdites: Array<[Stage, Stage]> = [
      ['idle', 'coding'], // il faut d'abord verrouiller la spec
      ['idle', 'review'],
      ['merged', 'coding'], // merged est terminal
      ['aborted', 'idle'], // aborted est terminal
      ['review', 'testing'], // review renvoie vers coding, jamais testing
      ['coding', 'review'], // pas de saut par-dessus les gates
      ['coding', 'merged'],
      ['spec_locked', 'testing'],
    ];
    for (const [from, to] of interdites) {
      expect(() => assertTransition(from, to), `${from} → ${to} devrait être interdite`).toThrow();
    }
  });
});

describe('StatusStore', () => {
  it('load() rend null si le fichier est absent', () => {
    const store = new StatusStore(path.join(dossierTemp(), 'status.json'));
    expect(store.load()).toBeNull();
  });

  it('save() puis load() est fidèle (aller-retour complet)', () => {
    const dir = dossierTemp();
    const store = new StatusStore(path.join(dir, 'status.json'));
    const s = statutDeTest();

    store.save(s);
    expect(store.load()).toEqual(s);
  });

  it("écrit atomiquement : pas de fichier temporaire résiduel, ré-écriture d'un fichier existant OK", () => {
    const dir = dossierTemp();
    const chemin = path.join(dir, 'status.json');
    const store = new StatusStore(chemin);
    const s = statutDeTest();

    store.save(s);
    // Deuxième save par-dessus l'existant (le rename doit écraser, y compris sous Windows).
    const s2: StatusJson = { ...s, stage: 'spec_locked', spec_hash: 'a'.repeat(64) };
    store.save(s2);

    expect(store.load()).toEqual(s2);
    // Seul status.json doit subsister dans le dossier : aucun .tmp résiduel.
    expect(fs.readdirSync(dir)).toEqual(['status.json']);
  });
});

describe('sha256File', () => {
  it('calcule le sha256 hex du contenu du fichier', () => {
    const dir = dossierTemp();
    const fichier = path.join(dir, 'spec.md');
    const contenu = '# Spec figée\n\ncontenu de test — accents éàü\n';
    fs.writeFileSync(fichier, contenu, 'utf8');

    const attendu = crypto.createHash('sha256').update(Buffer.from(contenu, 'utf8')).digest('hex');
    expect(sha256File(fichier)).toBe(attendu);
  });
});
