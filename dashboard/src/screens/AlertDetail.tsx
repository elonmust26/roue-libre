/**
 * Écran 5 — Détail d'alerte : type traduit, contexte (statut bloqué, dernière
 * action par rôle, dernier résultat de gate), et les 3 actions de sortie.
 */

import { useMemo, useState } from 'react';
import type { StatusJson, OrchestratorEvent, RoleName, GateResult } from '../../../src/core/types';
import type { TabId } from '../App';
import { actionRetry, actionAbort } from '../api';
import { InlineConfirm } from '../components/InlineConfirm';
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

const ROLES: RoleName[] = ['prompteur', 'coder', 'testeur'];

/** Dernier résultat de gate connu (coder ou tester, le plus récent). */
function lastGate(status: StatusJson): GateResult | null {
  const { coder, tester } = status.gates;
  if (coder && tester) return coder.at > tester.at ? coder : tester;
  return coder ?? tester ?? null;
}

export function AlertDetail({ status, events, onNavigate }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lastByRole = useMemo(() => {
    const map = new Map<RoleName, OrchestratorEvent>();
    for (const e of events) {
      if (e.role !== null) map.set(e.role, e);
    }
    return map;
  }, [events]);

  if (!status || status.stage !== 'blocked') {
    return (
      <div className="screen screen-narrow">
        <h2 className="screen-title">Détail d'alerte</h2>
        <p className="muted empty-state">Aucune alerte active.</p>
      </div>
    );
  }

  const gate = lastGate(status);

  const doRetry = async () => {
    setBusy(true);
    setError(null);
    try {
      await actionRetry();
      onNavigate('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /** Modifier la spec = annuler le cycle courant + repartir sur l'écran Nouvelle tâche. */
  const doEditSpec = async () => {
    setBusy(true);
    setError(null);
    try {
      await actionAbort();
      onNavigate('new');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const doAbort = async () => {
    setError(null);
    try {
      await actionAbort();
      onNavigate('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="screen screen-narrow">
      <h2 className="screen-title">Détail d'alerte</h2>

      <div className="alert-zone" role="alert">
        <div className="alert-zone-text">
          <strong>{status.blocked_reason ? ALERT_LABELS[status.blocked_reason] : 'Motif inconnu'}</strong>
          <span>
            Bloqué depuis l'étape {status.blocked_from ? STAGE_LABELS[status.blocked_from] : '—'}
          </span>
        </div>
      </div>

      <section className="card">
        <h3 className="card-title">Contexte</h3>
        <dl className="context-list">
          <div className="context-row">
            <dt>Étape bloquée</dt>
            <dd>{status.blocked_from ? `${STAGE_LABELS[status.blocked_from]} (${status.blocked_from})` : '—'}</dd>
          </div>
          <div className="context-row">
            <dt>Itération</dt>
            <dd>{status.iteration}/{status.max_iterations}</dd>
          </div>
          <div className="context-row">
            <dt>Budget</dt>
            <dd>{usd(status.cost_usd_used)} / {usd(status.budget_usd)}</dd>
          </div>
          <div className="context-row">
            <dt>Dernière transition</dt>
            <dd>{relativeTime(status.last_transition_at)}</dd>
          </div>
        </dl>
      </section>

      <section className="card">
        <h3 className="card-title">Dernière action par rôle</h3>
        <dl className="context-list">
          {ROLES.map((role) => {
            const last = lastByRole.get(role);
            return (
              <div key={role} className="context-row">
                <dt>{ROLE_LABELS[role]}</dt>
                <dd>
                  {last ? (
                    <>
                      {EVENT_TYPE_LABELS[last.type]}
                      {eventExcerpt(last) && <span className="muted"> — {eventExcerpt(last)}</span>}
                      <span className="muted"> · {relativeTime(last.at)}</span>
                    </>
                  ) : (
                    <span className="muted">aucune action</span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="card">
        <h3 className="card-title">Dernier résultat de gate</h3>
        {gate === null ? (
          <p className="muted">Aucune gate exécutée pour l'instant.</p>
        ) : (
          <>
            <div className="gate-summary">
              <span className={`badge ${gate.ok ? 'badge-ok' : 'badge-danger'}`}>
                gate {gate.name} — {gate.ok ? 'passée' : 'échouée'}
              </span>
              <span className="muted">exit {gate.exit_code}</span>
            </div>
            <span className="label">stdout</span>
            <pre className="detail-pre">{gate.stdout || '(vide)'}</pre>
            <span className="label">stderr</span>
            <pre className="detail-pre">{gate.stderr || '(vide)'}</pre>
          </>
        )}
      </section>

      <section className="card review-actions">
        <div className="review-action-row">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void doRetry()}>
            Relancer depuis cette étape
          </button>
        </div>
        <div className="review-action-block">
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void doEditSpec()}>
            Modifier la spec et relancer (nouveau cycle)
          </button>
          <p className="hint">
            La spec est figée : la modifier = annuler la tâche courante + démarrer un nouveau cycle explicite.
          </p>
        </div>
        <div className="review-action-row">
          <InlineConfirm
            label="Abandonner"
            question="Abandonner définitivement la tâche ?"
            onConfirm={doAbort}
            danger
          />
        </div>
      </section>

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
