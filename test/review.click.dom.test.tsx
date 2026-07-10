// @vitest-environment jsdom
/**
 * Preuve Phase 1 (niveau DOM) — reproduction automatisée du scénario utilisateur :
 * l'écran Revue de diff est monté (React Testing Library) face à un VRAI serveur
 * roue-libre en mode simulé, cycle arrivé en stage review. On clique
 * « Approuver et merger » puis « Confirmer » comme l'utilisateur, et on vérifie :
 *   1. status.json passe à stage merged (écrit sur disque par le moteur) ;
 *   2. un événement 'merge' (équivalent merge_approved) est appendé à events.ndjson ;
 *   3. un message de confirmation est présent dans le DOM du composant.
 * Les deux autres boutons (« Renvoyer au coder », « Annuler la tâche ») sont
 * vérifiés de la même façon, ainsi que la raison visible quand hors review.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { Orchestrator } from '../src/core/engine.js';
import { startServer } from '../src/server/index.js';
import { SimulatedGateRunner, SimulatedGitOps, SimulatedRunner } from '../src/sim/runner.js';
import { DEFAULT_CONFIG, ORCH_DIR } from '../src/core/types.js';
import type { OrchestratorEvent, RoueConfig, ServerHandle, StatusJson } from '../src/core/types.js';
import { DiffReview } from '../dashboard/src/screens/DiffReview';

// En environnement jsdom, import.meta.url est réécrite en http:// — on passe
// par le cwd de vitest (la racine du package) pour retrouver les templates.
const RACINE_PACKAGE = process.cwd();

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attendre<T>(predicat: () => T | undefined, timeoutMs: number, motif: string): Promise<T> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    const valeur = predicat();
    if (valeur !== undefined) return valeur;
    await pause(50);
  }
  throw new Error(`timeout: ${motif}`);
}

function lireStatusJson(repoDir: string): StatusJson {
  return JSON.parse(fs.readFileSync(path.join(repoDir, ORCH_DIR, 'status.json'), 'utf8')) as StatusJson;
}

function lireEvents(repoDir: string): OrchestratorEvent[] {
  return fs
    .readFileSync(path.join(repoDir, ORCH_DIR, 'events.ndjson'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as OrchestratorEvent);
}

interface Contexte {
  repoDir: string;
  orchestrateur: Orchestrator;
  poignee: ServerHandle;
}

/** Serveur réel + cycle simulé jusqu'à review ; fetch du DOM redirigé vers ce serveur. */
async function monterContexteEnReview(): Promise<Contexte> {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roue-dom-'));
  fs.mkdirSync(path.join(repoDir, ORCH_DIR), { recursive: true });
  const config: RoueConfig = { ...DEFAULT_CONFIG, budget_usd: 5, max_iterations: 3, timeout_minutes: 1 };
  const orchestrateur = new Orchestrator({
    repoDir,
    packageRoot: RACINE_PACKAGE,
    config,
    runner: new SimulatedRunner(),
    gates: new SimulatedGateRunner(),
    git: new SimulatedGitOps({ repoDir }),
  });
  const port = 4900 + Math.floor(Math.random() * 90);
  const poignee = await startServer({ port, orchestrator: orchestrateur });

  await orchestrateur.createTask({
    description: 'démo',
    success_criterion: 'le fichier demo.txt contient OK',
    risk_level: 'low',
  });
  await orchestrateur.confirmTask();
  await attendre(
    () => (orchestrateur.getStatus()?.stage === 'review' ? true : undefined),
    20000,
    `stage review jamais atteint (actuel: ${orchestrateur.getStatus()?.stage})`,
  );

  return { repoDir, orchestrateur, poignee };
}

describe('écran Revue de diff — clic réel sur les 3 boutons (preuve Phase 1)', () => {
  const fetchOriginal = globalThis.fetch;
  let ctx: Contexte | null = null;

  beforeEach(async () => {
    ctx = await monterContexteEnReview();
    const base = `http://127.0.0.1:${ctx.poignee.port}`;
    // Le client REST du dashboard utilise des URLs relatives ('/api/…') :
    // on les résout vers le serveur de test, sans toucher au code de production.
    globalThis.fetch = ((entree: RequestInfo | URL, init?: RequestInit) =>
      fetchOriginal(
        typeof entree === 'string' && entree.startsWith('/') ? `${base}${entree}` : entree,
        init,
      )) as typeof fetch;
  });

  afterEach(async () => {
    globalThis.fetch = fetchOriginal;
    cleanup();
    if (ctx) await ctx.poignee.close();
    ctx = null;
  });

  it('« Approuver et merger » → status.json merged + événement merge + confirmation dans le DOM', async () => {
    const statut = ctx!.orchestrateur.getStatus();
    expect(statut?.stage).toBe('review');

    render(<DiffReview status={statut} onNavigate={() => {}} />);

    // 1er clic : le bouton demande confirmation inline (retour visuel immédiat).
    fireEvent.click(screen.getByRole('button', { name: 'Approuver et merger' }));
    expect(screen.getByText('Confirmer le merge ?')).toBeTruthy();

    // 2e clic : Confirmer → appel réseau réel vers POST /api/actions/merge.
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));

    // 3. Message de confirmation visible dans le DOM du composant.
    await waitFor(
      () => {
        const boite = screen.getByTestId('action-confirmation');
        expect(boite.textContent).toContain('PR mergée — la tâche est terminée.');
      },
      { timeout: 10000 },
    );

    // 1. status.json écrit sur disque par le moteur : stage merged.
    expect(lireStatusJson(ctx!.repoDir).stage).toBe('merged');
    expect(ctx!.orchestrateur.getStatus()?.stage).toBe('merged');

    // 2. Événement 'merge' (équivalent merge_approved) appendé dans events.ndjson.
    const evenements = lireEvents(ctx!.repoDir);
    expect(evenements.map((e) => e.type)).toContain('merge');
    const transitions = evenements
      .filter((e) => e.type === 'transition')
      .map((e) => `${String(e.data.from)}→${String(e.data.to)}`);
    expect(transitions).toContain('review→merged');
  });

  it('« Renvoyer au coder avec commentaire » → return_to_coder + confirmation dans le DOM', async () => {
    const statut = ctx!.orchestrateur.getStatus();
    render(<DiffReview status={statut} onNavigate={() => {}} />);

    fireEvent.change(screen.getByLabelText('Renvoyer au coder avec commentaire'), {
      target: { value: 'corrige la casse du message' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Renvoyer au coder' }));

    await waitFor(
      () => {
        const boite = screen.getByTestId('action-confirmation');
        expect(boite.textContent).toContain('Tâche renvoyée au coder');
      },
      { timeout: 10000 },
    );

    const renvoi = lireEvents(ctx!.repoDir).find((e) => e.type === 'return_to_coder');
    expect(renvoi).toBeDefined();
    expect((renvoi!.data as { comment?: string }).comment).toBe('corrige la casse du message');

    // Laisse le cycle relancé revenir en review avant la fermeture du serveur.
    await attendre(
      () => (ctx!.orchestrateur.getStatus()?.stage === 'review' ? true : undefined),
      20000,
      'le cycle relancé après renvoi ne revient pas en review',
    );
  });

  it('« Annuler la tâche » → status.json aborted + événement abort + confirmation dans le DOM', async () => {
    const statut = ctx!.orchestrateur.getStatus();
    render(<DiffReview status={statut} onNavigate={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler la tâche' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer' }));

    await waitFor(
      () => {
        const boite = screen.getByTestId('action-confirmation');
        expect(boite.textContent).toContain('Tâche annulée');
      },
      { timeout: 10000 },
    );

    expect(lireStatusJson(ctx!.repoDir).stage).toBe('aborted');
    expect(lireEvents(ctx!.repoDir).map((e) => e.type)).toContain('abort');
  });

  it('hors stage review : la raison est VISIBLE à l\'écran, plus jamais de clic avalé en silence', async () => {
    const statut = { ...ctx!.orchestrateur.getStatus()!, stage: 'coding' as const };
    render(<DiffReview status={statut} onNavigate={() => {}} />);

    // La raison de l'indisponibilité est affichée en clair dans le DOM.
    expect(screen.getByText(/Actions indisponibles/).textContent).toContain('coding');
    // Et le bouton merger est réellement désactivé (pas de no-op silencieux).
    const bouton = screen.getByRole('button', { name: 'Approuver et merger' }) as HTMLButtonElement;
    expect(bouton.disabled).toBe(true);
  });
});
