# PRD — Roue Libre (orchestrateur multi-Claude Code)

## 1. Contexte et problème

Aujourd'hui, l'utilisateur agit comme bus de communication manuel entre plusieurs instances Claude Code (prompteur / coder / testeur-merge via Chrome). Chaque relance est un aller-retour humain. Objectif : un système qui orchestre 3 agents Claude Code sur une tâche de bout en bout, avec un minimum d'intervention humaine, sans sacrifier la fiabilité ni gaspiller du budget de tokens.

## 2. Objectifs

- Éliminer le ping-pong manuel entre les 3 agents pour les tâches de complexité faible à moyenne.
- Garantir que chaque étape (code → test → merge) est vérifiée par une preuve objective, jamais par la simple déclaration de l'agent.
- Donner à l'utilisateur un point de contrôle unique (dashboard) pour superviser sans devoir lire chaque pane tmux.
- Limiter la consommation de tokens en bornant strictement ce que chaque agent relit à chaque tour.

## 3. Non-objectifs

- Ne pas viser l'autonomie totale sans aucune validation humaine sur les tâches à fort risque (migrations DB, schémas de facturation, données de production).
- Ne pas gérer plus de 3 agents en v1.
- Ne pas remplacer la revue de code humaine sur les branches protégées (main/production).

## 4. Rôles des 3 agents

| Agent | Rôle | Accès |
|---|---|---|
| Prompteur (A) | Décompose la tâche, écrit la spec figée, valide la fin d'itération | Lecture seule sur le repo, écriture sur `spec.md` |
| Coder (B) | Implémente sur une branche/worktree dédiée | Écriture sur son worktree uniquement |
| Testeur/Merge (C) | Relance les tests à froid, vérifie le diff, merge si conforme, publie via Chrome si besoin | Lecture sur le worktree du coder, écriture sur main via PR uniquement |

## 5. Architecture

- **Bus d'état** : un fichier `status.json` unique, écrit de façon atomique (écriture sur fichier temporaire + rename), jamais en écriture concurrente.
- **Isolation** : chaque agent travaille sur son propre `git worktree` — jamais d'accès concurrent au même répertoire.
- **Watcher** : un script externe (hors Claude Code) surveille `status.json` et route les prompts via `tmux send-keys`. Aucun agent ne se relance lui-même.
- **Preuve objective obligatoire à chaque transition** : un hook shell exécute un check (git diff non vide, tests exit code 0, build clean) avant d'autoriser l'écriture du statut suivant. Le hook, pas l'agent, décide si la transition est permise.
- **Dashboard local** (petit serveur web, lecture seule) : visualise l'état en temps réel, l'historique des itérations, les diffs, et les alertes.

## 6. Garde-fous (repris et formalisés de la discussion)

1. **Pas de confiance déclarative** : chaque "done" doit être validé par un script de vérification externe, jamais accepté tel quel.
2. **Compteur d'itérations dur** : max 3 aller-retours coder↔testeur sur une même tâche ; au-delà, arrêt automatique + alerte à l'utilisateur.
3. **Spec figée** : `spec.md` n'est jamais réécrite en cours de tâche ; toute modification de la tâche annule l'itération en cours et force un nouveau cycle explicite.
4. **Timeout par étape** : si un statut ne change pas pendant N minutes (configurable), alerte au lieu d'attente infinie.
5. **Merge jamais automatique sur main** : le testeur crée une PR ; le merge final sur une branche protégée reste une action validée par l'utilisateur (bouton dans le dashboard), sauf sur les branches de sandbox/preview.
6. **Sandbox d'exécution** : aucune commande destructrice (force-push, rm -rf, DROP TABLE) n'est exécutable sans passer par une liste blanche de commandes autorisées.
7. **Contrôle de dérive de contexte** : chaque agent relit intégralement `spec.md` à chaque tour, jamais un résumé compressé.
8. **Budget de tokens par itération** : seuil configurable ; dépassement → pause et alerte plutôt que poursuite silencieuse.

## 7. Écrans à développer

### Écran 1 — Dashboard principal
**But** : vue d'ensemble en un coup d'œil de l'état du pipeline.
**Contenu** :
- Bandeau d'état global : Idle / En cours / Bloqué / Terminé (couleur : gris / bleu / rouge / vert)
- 3 cartes agent (Prompteur, Coder, Testeur) affichant : statut actuel, dernière action, timestamp de dernière activité
- Compteur d'itération en cours (ex : "Itération 2/3")
- Compteur de budget tokens consommés sur la tâche en cours (barre de progression avec seuil d'alerte)
- Bouton "Nouvelle tâche" (ouvre Écran 2)
- Zone d'alerte persistante si un timeout ou une boucle est détectée, avec bouton "Voir le détail"

### Écran 2 — Création de tâche
**But** : figer la spec avant tout lancement.
**Contenu** :
- Champ texte "Description de la tâche"
- Projet auto-détecté (git remote / nom de dossier), modifiable en champ libre — aucun projet prédéfini
- Champ "Critère de succès explicite" (obligatoire — pas de lancement sans définition claire de "fini")
- Sélecteur de niveau de risque (Faible / Moyen / Élevé) → détermine si le merge final nécessite validation manuelle obligatoire
- Bouton "Générer la spec figée" → génère `spec.md`, affiche un aperçu avant confirmation
- Bouton "Lancer le pipeline" (grisé tant que la spec n'est pas confirmée)

### Écran 3 — Timeline / journal d'exécution
**But** : suivre chronologiquement ce que chaque agent a fait, sans avoir à lire les panes tmux.
**Contenu** :
- Liste chronologique d'événements (prompt envoyé, réponse reçue, transition de statut, vérification passée/échouée)
- Filtre par agent (A/B/C)
- Chaque événement expansible pour voir le prompt exact envoyé et la réponse complète
- Marqueurs visuels distincts pour : succès de vérification, échec de vérification, alerte de timeout, dépassement de budget

### Écran 4 — Revue de diff
**But** : point de validation humaine avant merge sur branche protégée.
**Contenu** :
- Diff complet (vue côte-à-côte ou unifiée) de la branche du coder vs la cible
- Résultat des tests relancés à froid par le testeur (statut + logs)
- Résumé généré par l'agent testeur de ce qui a changé et pourquoi
- Boutons : "Approuver et merger" / "Renvoyer au coder avec commentaire" / "Annuler la tâche"
- Champ de commentaire libre si renvoi au coder (devient une nouvelle instruction figée)

### Écran 5 — Détail d'alerte / blocage
**But** : diagnostiquer rapidement pourquoi le pipeline s'est arrêté.
**Contenu** :
- Type d'alerte (boucle détectée / timeout / budget dépassé / échec de vérification répété)
- Contexte : dernier statut connu, dernière action de chaque agent, dernier diff produit
- Actions possibles : "Relancer depuis cette étape" / "Modifier la spec et relancer" / "Abandonner la tâche"

### Écran 6 — Paramètres
**But** : configurer les seuils sans toucher au code.
**Contenu** :
- Seuil de tentatives max par tâche (défaut 3)
- Seuil de timeout par étape (en minutes)
- Seuil de budget tokens par itération
- Liste blanche des commandes shell autorisées pour les agents
- Niveau de risque par défaut par repo cible

## 8. Modèle de données (status.json étendu)

```json
{
  "task_id": "uuid",
  "project": "nom-du-repo-cible",
  "risk_level": "medium",
  "spec_path": "spec.md",
  "stage": "ready_for_tester",
  "iteration": 1,
  "max_iterations": 3,
  "token_budget": 200000,
  "tokens_used": 42000,
  "last_transition_at": "iso8601",
  "timeout_minutes": 10,
  "verification": {
    "coder_diff_nonempty": true,
    "tests_passed": null,
    "build_clean": null
  },
  "history": []
}
```

## 9. Métriques de succès

- Nombre de tâches menées à terme sans intervention humaine hors validation de merge finale
- Nombre d'alertes déclenchées vs nombre de tâches réellement bloquées à raison (taux de faux positifs)
- Tokens consommés par tâche terminée vs tâches abandonnées (ratio de gaspillage)
- Nombre de boucles de faux consensus détectées et bloquées par les vérifications objectives

## 10. Risques ouverts (non résolus par ce PRD, à trancher au cas par cas)

- Définir précisément, projet par projet, ce qui constitue une "preuve objective" suffisante (les tests unitaires ne couvrent pas tout, notamment sur les sites WordPress sans suite de tests).
- Le compromis autonomie / certitude / coût n'a pas de réglage universel — le niveau de risque par tâche (Écran 2) est la seule variable qui permet de l'ajuster, pas une solution définitive.
