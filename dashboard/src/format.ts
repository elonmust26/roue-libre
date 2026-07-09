/**
 * Libellés français, horodatages relatifs et aides de présentation
 * partagés par les écrans du dashboard.
 */

import type {
  Stage,
  AlertType,
  EventType,
  RoleName,
  OrchestratorEvent,
} from '../../src/core/types';

export const STAGE_LABELS: Record<Stage, string> = {
  idle: 'Idle',
  spec_locked: 'Spec verrouillée',
  coding: 'Codage',
  gate_coder: 'Gate coder',
  testing: 'Tests',
  gate_tester: 'Gate testeur',
  review: 'Revue',
  merged: 'Terminé',
  blocked: 'Bloqué',
  aborted: 'Annulé',
};

export const ALERT_LABELS: Record<AlertType, string> = {
  loop: 'Boucle détectée',
  timeout: 'Timeout',
  budget: 'Budget dépassé',
  gate_failed_repeated: 'Gate échouée répétée',
  spec_altered: 'Spec altérée',
};

export const ROLE_LABELS: Record<RoleName, string> = {
  prompteur: 'Prompteur',
  coder: 'Coder',
  testeur: 'Testeur',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  task_created: 'Tâche créée',
  spec_locked: 'Spec verrouillée',
  prompt_sent: 'Prompt envoyé',
  chunk: 'Chunk',
  role_result: 'Résultat du rôle',
  gate_passed: 'Gate passée',
  gate_failed: 'Gate échouée',
  transition: 'Transition',
  alert: 'Alerte',
  merge: 'Merge',
  abort: 'Abandon',
  return_to_coder: 'Renvoi au coder',
};

/** Horodatage relatif en français : « à l'instant », « il y a 2 min »… */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 45) return "à l'instant";
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

/** Heure locale courte pour la Timeline (HH:MM:SS). */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('fr-FR');
}

/** Montant en dollars, 2 décimales. */
export function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/** Tronque une chaîne pour les extraits (dernière action, lignes de timeline). */
export function excerpt(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Extrait lisible de la charge utile d'un événement (pour les lignes compactes). */
export function eventExcerpt(e: OrchestratorEvent): string {
  const d = e.data;
  if (typeof d.prompt === 'string') return excerpt(d.prompt);
  if (typeof d.result === 'string') return excerpt(d.result);
  if (typeof d.raw === 'string') return excerpt(d.raw, 100);
  if (typeof d.from === 'string' && typeof d.to === 'string') {
    const fromLabel = STAGE_LABELS[d.from as Stage] ?? d.from;
    const toLabel = STAGE_LABELS[d.to as Stage] ?? d.to;
    return `${fromLabel} → ${toLabel}`;
  }
  if (typeof d.type === 'string' && d.type in ALERT_LABELS) {
    const base = ALERT_LABELS[d.type as AlertType];
    return typeof d.message === 'string' ? `${base} — ${excerpt(d.message, 100)}` : base;
  }
  if (typeof d.message === 'string') return excerpt(d.message);
  if (typeof d.comment === 'string') return excerpt(d.comment);
  if (typeof d.stdout === 'string' && d.stdout.trim() !== '') return excerpt(d.stdout, 100);
  const keys = Object.keys(d);
  return keys.length === 0 ? '' : excerpt(JSON.stringify(d), 100);
}

/** Marqueur visuel distinct par type d'événement (symbole + classe couleur). */
export function eventMarker(e: OrchestratorEvent): { symbol: string; className: string } {
  switch (e.type) {
    case 'gate_passed':
      return { symbol: '✓', className: 'marker-ok' };
    case 'gate_failed':
      return { symbol: '✗', className: 'marker-danger' };
    case 'alert': {
      const t = e.data.type;
      if (t === 'timeout') return { symbol: '⏱', className: 'marker-warn' };
      if (t === 'budget') return { symbol: '💰', className: 'marker-warn' };
      return { symbol: '⚠', className: 'marker-warn' };
    }
    case 'transition':
      return { symbol: '→', className: 'marker-accent' };
    case 'merge':
      return { symbol: '✓', className: 'marker-ok' };
    case 'abort':
      return { symbol: '✗', className: 'marker-muted' };
    case 'chunk':
      return { symbol: '·', className: 'marker-muted' };
    default:
      return { symbol: '•', className: 'marker-muted' };
  }
}
