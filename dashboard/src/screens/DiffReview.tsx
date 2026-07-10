/**
 * Écran 4 — Revue de diff : diff unifié colorisé, résultat de la gate testeur,
 * résumé du testeur, lien PR, et les 3 actions (merger / renvoyer / annuler).
 *
 * Règle issue du bug v0.1 « clic sans effet » : CHAQUE action produit un retour
 * visuel immédiat — état de chargement pendant la requête, puis message de
 * confirmation persistant (ou erreur exacte). Un bouton indisponible affiche
 * sa raison à l'écran, jamais seulement en info-bulle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StatusJson, DiffReview as DiffReviewData } from '../../../src/core/types';
import type { TabId } from '../App';
import { fetchDiff, actionMerge, actionReturn, actionAbort } from '../api';
import { InlineConfirm } from '../components/InlineConfirm';

interface Props {
  status: StatusJson | null;
  onNavigate: (tab: TabId) => void;
}

/** Confirmation persistante après une action réussie. */
interface ActionDone {
  kind: 'merged' | 'returned' | 'aborted';
  message: string;
}

/** Classe CSS d'une ligne de diff unifié (parsing simple ligne par ligne). */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-file';
  return 'diff-ctx';
}

export function DiffReview({ status, onNavigate }: Props) {
  const [review, setReview] = useState<DiffReviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [gateOpen, setGateOpen] = useState(false);
  /** Action en cours de requête (retour visuel immédiat), sinon null. */
  const [pending, setPending] = useState<'merge' | 'return' | 'abort' | null>(null);
  const [done, setDone] = useState<ActionDone | null>(null);
  const doneRef = useRef<HTMLDivElement | null>(null);

  // La confirmation doit être VUE : on la fait défiler en vue dès qu'elle apparaît
  // (l'utilisateur vient de cliquer en bas de page, la boîte s'affiche en haut).
  useEffect(() => {
    // scrollIntoView absent de certains environnements (jsdom) : appel défensif.
    if (done && typeof doneRef.current?.scrollIntoView === 'function') {
      doneRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [done]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReview(await fetchDiff());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stage = status?.stage;
  const inReview = stage === 'review';

  const doMerge = async () => {
    setError(null);
    setPending('merge');
    try {
      await actionMerge();
      setDone({
        kind: 'merged',
        message: 'PR mergée — la tâche est terminée.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const doReturn = async () => {
    setError(null);
    setPending('return');
    try {
      await actionReturn(comment.trim());
      setComment('');
      setDone({
        kind: 'returned',
        message: 'Tâche renvoyée au coder — le commentaire est l\'instruction figée de la nouvelle itération.',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const doAbort = async () => {
    setError(null);
    setPending('abort');
    try {
      await actionAbort();
      setDone({ kind: 'aborted', message: 'Tâche annulée définitivement.' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const gate = review?.gate_tester ?? null;

  return (
    <div className="screen">
      <div className="screen-head">
        <h2 className="screen-title">Revue de diff</h2>
        <button type="button" className="btn btn-ghost" disabled={loading} onClick={() => void refresh()}>
          {loading ? 'Chargement…' : 'Rafraîchir'}
        </button>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}

      {done && (
        <div ref={doneRef} className={`confirm-box confirm-${done.kind}`} role="status" data-testid="action-confirmation">
          <span className="confirm-icon" aria-hidden="true">
            {done.kind === 'aborted' ? '✕' : '✓'}
          </span>
          <span className="confirm-message">{done.message}</span>
          <button type="button" className="btn btn-ghost" onClick={() => onNavigate('dashboard')}>
            Voir le dashboard
          </button>
        </div>
      )}

      <section className="card">
        <h3 className="card-title">Diff unifié (branche coder vs cible)</h3>
        {review === null || review.diff.trim() === '' ? (
          <p className="muted">Aucun diff disponible.</p>
        ) : (
          <pre className="diff-view">
            {review.diff.split('\n').map((line, i) => (
              <span key={i} className={`diff-line ${diffLineClass(line)}`}>
                {line}
                {'\n'}
              </span>
            ))}
          </pre>
        )}
      </section>

      <section className="card">
        <h3 className="card-title">Gate testeur</h3>
        {gate === null ? (
          <p className="muted">Pas encore de résultat de gate testeur.</p>
        ) : (
          <>
            <div className="gate-summary">
              <span className={`badge ${gate.ok ? 'badge-ok' : 'badge-danger'}`}>
                {gate.ok ? 'passée' : 'échouée'}
              </span>
              <span className="muted">
                exit {gate.exit_code} · {(gate.duration_ms / 1000).toFixed(1)} s
              </span>
              <button type="button" className="btn btn-ghost btn-small" onClick={() => setGateOpen((v) => !v)}>
                {gateOpen ? 'Masquer les logs' : 'Voir stdout / stderr'}
              </button>
            </div>
            {gateOpen && (
              <div className="gate-logs">
                <span className="label">stdout</span>
                <pre className="detail-pre">{gate.stdout || '(vide)'}</pre>
                <span className="label">stderr</span>
                <pre className="detail-pre">{gate.stderr || '(vide)'}</pre>
              </div>
            )}
          </>
        )}
      </section>

      <section className="card">
        <h3 className="card-title">Résumé du testeur</h3>
        {review && review.tester_summary.trim() !== '' ? (
          <p className="tester-summary">{review.tester_summary}</p>
        ) : (
          <p className="muted">Pas encore de résumé.</p>
        )}
        {review?.pr_url && (
          <p>
            <a className="pr-link" href={review.pr_url} target="_blank" rel="noreferrer">
              Voir la PR ↗
            </a>
          </p>
        )}
      </section>

      {/* Les actions disparaissent une fois la tâche terminée par une action de cet écran. */}
      {!done && (
        <section className="card review-actions">
          {!inReview && (
            <p className="actions-unavailable" role="note">
              Actions indisponibles : la tâche est à l'étape «&nbsp;{stage ?? 'aucune tâche'}&nbsp;» —
              elles ne s'activent qu'à l'étape Revue.
            </p>
          )}

          <div className="review-action-row">
            <InlineConfirm
              label="Approuver et merger"
              question="Confirmer le merge ?"
              busyLabel="Merge en cours…"
              onConfirm={doMerge}
              disabled={!inReview || pending !== null}
              disabledReason="Disponible uniquement à l'étape Revue"
            />
          </div>

          <div className="review-action-block">
            <label className="label" htmlFor="dr-comment">Renvoyer au coder avec commentaire</label>
            <textarea
              id="dr-comment"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Ce qui doit être corrigé…"
              disabled={!inReview}
            />
            <p className="hint">Le commentaire devient instruction figée de l'itération suivante.</p>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!inReview || comment.trim() === '' || pending !== null}
              title={comment.trim() === '' ? 'Commentaire obligatoire' : undefined}
              onClick={() => void doReturn()}
            >
              {pending === 'return' ? 'Envoi en cours…' : 'Renvoyer au coder'}
            </button>
          </div>

          <div className="review-action-row">
            <InlineConfirm
              label="Annuler la tâche"
              question="Annuler définitivement la tâche ?"
              busyLabel="Annulation…"
              onConfirm={doAbort}
              disabled={pending !== null}
              danger
            />
          </div>
        </section>
      )}
    </div>
  );
}
