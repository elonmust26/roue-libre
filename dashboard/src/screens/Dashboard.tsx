/**
 * Écran 1 — Dashboard principal : bandeau d'état global, 3 cartes rôle
 * (avec console live extensible — v0.2), itération, barre de budget,
 * bouton Nouvelle tâche, zone d'alerte persistante.
 */

import { useEffect, useMemo, useState } from 'react';
import type { StatusJson, OrchestratorEvent, RoleName, Stage } from '../../../src/core/types';
import type { TabId } from '../App';
import { RoleConsole } from '../components/RoleConsole';
import {
  STAGE_LABELS,
  ALERT_LABELS,
  ROLE_LABELS,
  EVENT_TYPE_LABELS,
  relativeTime,
  eventExcerpt,
  usd,
} from '../format';

interface Props {
  status: StatusJson | null;
  events: OrchestratorEvent[];
  onNavigate: (tab: TabId) => void;
}

type GlobalState = 'idle' | 'running' | 'blocked' | 'done' | 'aborted';

/** États visuels distincts : couleur + icône, jamais seulement du texte. */
const STATE_ICONS: Record<GlobalState, string> = {
  idle: '◌',
  running: '◉',
  blocked: '⚠',
  done: '✓',
  aborted: '✕',
};

/** État global dérivé du stage (idle/absent → Idle ; merged → Terminé ; etc.). */
function globalState(status: StatusJson | null): { state: GlobalState; label: string } {
  const stage = status?.stage;
  if (!stage || stage === 'idle') return { state: 'idle', label: 'Idle' };
  if (stage === 'merged') return { state: 'done', label: 'Terminé' };
  if (stage === 'blocked') return { state: 'blocked', label: 'Bloqué' };
  if (stage === 'aborted') return { state: 'aborted', label: 'Annulé' };
  return { state: 'running', label: `En cours — ${STAGE_LABELS[stage]}` };
}

/** Un rôle est « actif » si le stage courant le concerne. */
function isRoleActive(role: RoleName, stage: Stage | undefined): boolean {
  if (!stage) return false;
  switch (role) {
    case 'prompteur':
      return stage === 'spec_locked';
    case 'coder':
      return stage === 'coding' || stage === 'gate_coder';
    case 'testeur':
      return stage === 'testing' || stage === 'gate_tester';
  }
}

/** État visuel d'une carte rôle : idle / en cours / bloqué / terminé. */
function roleState(role: RoleName, status: StatusJson | null): GlobalState {
  const stage = status?.stage;
  if (!stage) return 'idle';
  if (isRoleActive(role, stage)) return 'running';
  if (stage === 'blocked' && status?.blocked_from && isRoleActive(role, status.blocked_from)) {
    return 'blocked';
  }
  if (stage === 'merged') return 'done';
  return 'idle';
}

const ROLE_STATE_LABELS: Record<GlobalState, string> = {
  idle: 'inactif',
  running: 'en cours',
  blocked: 'bloqué',
  done: 'terminé',
  aborted: 'annulé',
};

const ROLES: RoleName[] = ['prompteur', 'coder', 'testeur'];

export function Dashboard({ status, events, onNavigate }: Props) {
  // Tic périodique pour rafraîchir les horodatages relatifs (« il y a 2 min »).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // v0.2 — consoles live ouvertes par rôle.
  const [openConsoles, setOpenConsoles] = useState<Set<RoleName>>(new Set());
  const toggleConsole = (role: RoleName) => {
    setOpenConsoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  const { state, label } = globalState(status);

  // Dernier événement par rôle (les événements arrivent triés chronologiquement).
  const lastByRole = useMemo(() => {
    const map = new Map<RoleName, OrchestratorEvent>();
    for (const e of events) {
      if (e.role !== null) map.set(e.role, e);
    }
    return map;
  }, [events]);

  const budget = status?.budget_usd ?? 0;
  const used = status?.cost_usd_used ?? 0;
  const pct = budget > 0 ? (used / budget) * 100 : 0;
  const budgetClass = pct >= 100 ? 'budget-over' : pct >= 80 ? 'budget-warn' : 'budget-ok';

  return (
    <div className="screen">
      <div className={`state-banner state-${state}`}>
        <span className={`state-icon state-icon-${state}`} aria-hidden="true">
          {STATE_ICONS[state]}
        </span>
        <span className="state-label">{label}</span>
        {status && <span className="state-project">{status.project}</span>}
      </div>

      <div className="role-grid">
        {ROLES.map((role) => {
          const last = lastByRole.get(role);
          const rState = roleState(role, status);
          const consoleOpen = openConsoles.has(role);
          return (
            <section key={role} className={`card role-card role-${rState}${consoleOpen ? ' role-card-open' : ''}`}>
              <header className="role-card-header">
                <h3>{ROLE_LABELS[role]}</h3>
                <span className={`role-status role-status-${rState}`}>
                  <span className="role-status-icon" aria-hidden="true">{STATE_ICONS[rState]}</span>
                  {ROLE_STATE_LABELS[rState]}
                </span>
              </header>
              {last ? (
                <>
                  <p className="role-last-action">
                    <span className="role-event-type">{EVENT_TYPE_LABELS[last.type]}</span>
                    {eventExcerpt(last) && <span className="role-excerpt">{eventExcerpt(last)}</span>}
                  </p>
                  <p className="role-time">{relativeTime(last.at, now)}</p>
                </>
              ) : (
                <p className="muted">Aucune action pour l'instant</p>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-small role-console-toggle"
                onClick={() => toggleConsole(role)}
              >
                {consoleOpen ? '▾ Masquer la console' : '▸ Console live'}
              </button>
              {consoleOpen && <RoleConsole role={role} events={events} />}
            </section>
          );
        })}
      </div>

      <div className="dash-row">
        <section className="card dash-iteration">
          <span className="label">Itération</span>
          <span className="iteration-value">
            {status ? `${status.iteration}/${status.max_iterations}` : '—'}
          </span>
        </section>

        <section className="card dash-budget">
          <div className="budget-head">
            <span className="label">Budget</span>
            <span className={`budget-amounts ${budgetClass}`}>
              {status ? `${usd(used)} / ${usd(budget)}` : '—'}
            </span>
          </div>
          <div className="budget-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
            <div className={`budget-fill ${budgetClass}`} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        </section>

        <button type="button" className="btn btn-primary btn-new-task" onClick={() => onNavigate('new')}>
          + Nouvelle tâche
        </button>
      </div>

      {status?.stage === 'blocked' && (
        <div className="alert-zone" role="alert">
          <div className="alert-zone-text">
            <strong>Pipeline bloqué</strong>
            <span>{status.blocked_reason ? ALERT_LABELS[status.blocked_reason] : 'Motif inconnu'}</span>
          </div>
          <button type="button" className="btn btn-danger" onClick={() => onNavigate('alert')}>
            Voir le détail
          </button>
        </div>
      )}
    </div>
  );
}
