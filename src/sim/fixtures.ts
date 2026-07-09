/**
 * Fixtures du mode simulation (--simulate).
 * Réponses scriptées par rôle + coûts factices + diff factice.
 * Zéro token consommé : tout est généré localement.
 */

import type { RoleName } from '../core/types.js';

/** Coûts factices par rôle (USD), cumulés par le moteur comme en réel. */
export const COUTS_SIMULES: Record<RoleName, number> = {
  prompteur: 0.03,
  coder: 0.12,
  testeur: 0.08,
};

/** Tronque un prompt pour l'inclure lisiblement dans une réponse simulée. */
export function extraitPrompt(prompt: string, max = 200): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

/**
 * Spec markdown plausible rendue par le prompteur simulé.
 * Reprend le prompt reçu (description + critère de succès y sont inclus
 * par le moteur) pour rester cohérent avec la demande.
 */
export function specSimulee(prompt: string): string {
  return [
    '# Spec figée — tâche de démonstration',
    '',
    '> SPEC FIGÉE — toute modification en cours de tâche bloque le cycle (hash vérifié).',
    '',
    '## Objectif',
    '',
    'Créer un fichier `demo.txt` à la racine du repo cible, contenant exactement la chaîne `OK`,',
    'afin de démontrer le cycle complet coder → gates → testeur → review.',
    '',
    '## Périmètre',
    '',
    '- Ajout du fichier `demo.txt` (un seul fichier, une seule ligne).',
    '- Aucune modification d’un fichier existant.',
    '',
    '## Critère de succès vérifiable',
    '',
    '- `demo.txt` existe et son contenu est exactement `OK` (vérifiable par `cat demo.txt`).',
    '- Les tests du repo cible passent à froid (exit 0).',
    '',
    '## Hors-périmètre',
    '',
    '- Toute autre modification du repo (config, dépendances, docs).',
    '- Tout refactor opportuniste.',
    '',
    '## Notes',
    '',
    `Demande d’origine (extrait du prompt reçu) : « ${extraitPrompt(prompt)} »`,
    '',
  ].join('\n');
}

/**
 * Détecte si le prompt du coder contient une instruction d'itération
 * (échec de gate ou commentaire de renvoi injecté par le moteur).
 */
export function estUneIteration(prompt: string): boolean {
  return /it[ée]ration\s*[2-9]|échec de la gate|gate (échouée|failed)|return_comment|commentaire de renvoi|corrige|renvoi au coder/i.test(
    prompt,
  );
}

/** Récit d'implémentation rendu par le coder simulé. */
export function recitCoder(prompt: string): string {
  const lignes = [
    'Implémentation terminée sur mon worktree.',
    '',
    '- Hypothèse explicite : `demo.txt` doit contenir exactement `OK` (sans retour à la ligne superflu).',
    '- Créé `demo.txt` avec le contenu `OK`.',
    '- Commit atomique : `feat: crée demo.txt avec OK (spec démo)`.',
    '- Worktree propre : tout est committé, `git status` vide.',
    '',
    'J’estime le critère de succès atteint — la gate tranche.',
  ];
  if (estUneIteration(prompt)) {
    lignes.unshift(
      'itération 2 : correction suite à l’échec de la gate — le contenu de demo.txt ne satisfaisait pas le critère, il contient désormais exactement `OK`.',
      '',
    );
  }
  return lignes.join('\n');
}

/** Résumé de revue structuré rendu par le testeur simulé. */
export function resumeTesteur(prompt: string): string {
  return [
    '## Revue du testeur (à froid, sans croire le récit du coder)',
    '',
    '### Ce qui a changé',
    '- 1 fichier ajouté : `demo.txt` (contenu : `OK`). Aucun fichier existant modifié.',
    '',
    '### Vérifications relancées à froid',
    '- `spec.md` relue intégralement : le diff correspond au périmètre, rien de hors-périmètre détecté.',
    '- Tests relancés à froid : exit 0.',
    '- `cat demo.txt` → `OK` : critère de succès de la spec satisfait.',
    '',
    '### Risques',
    '- Aucun : changement additif minimal, traçable vers la spec.',
    '',
    '### Verdict',
    'Conforme à la spec. PR prête pour revue humaine — je ne merge pas moi-même.',
    '',
    `_(extrait du prompt reçu : « ${extraitPrompt(prompt, 120)} »)_`,
  ].join('\n');
}

/** Diff unifié factice réaliste : création de demo.txt contenant OK. */
export const DIFF_SIMULE = [
  'diff --git a/demo.txt b/demo.txt',
  'new file mode 100644',
  'index 0000000..d86bac9',
  '--- /dev/null',
  '+++ b/demo.txt',
  '@@ -0,0 +1 @@',
  '+OK',
  '',
].join('\n');

/** URL de PR factice ouverte par le testeur simulé. */
export const PR_URL_SIMULEE = 'https://github.com/simulated/roue-demo/pull/1';
