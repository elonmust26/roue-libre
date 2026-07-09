/**
 * Écran 4 — Revue de diff : diff unifié colorisé, résultat de la gate testeur,
 * résumé du testeur, lien PR, et les 3 actions (merger / renvoyer / annuler).
 */

import { useCallback, useEffect, useState } from 'react';
import type { StatusJson, DiffReview as DiffReviewData } from '../../../src/core/types';
import type { TabId } from '../App';
import { fetchDiff, actionMerge, actionReturn, actionAbort } from '../api';
import { InlineConfirm } from '../components/InlineConfirm';

interface Props {
  status: StatusJson | null;
  onNavigate: (tab: TabId) => void;
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
  const [busy, setBusy] = useState(false);

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

  const inReview = status?.stage === 'review';

  const doMerge = async () => {
    setError(null);
    try {
      await actionMerge();
      onNavigate('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const doReturn = async () => {
    setBusy(true);
    setError(null);
    try {
      await actionReturn(comment.trim());
      setComment('');
      onNavigate('dashboard');
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

      <section className="card review-actions">
        <div className="review-action-row">
          <InlineConfirm
            label="Approuver et merger"
            question="Confirmer le merge ?"
            onConfirm={doMerge}
            disabled={!inReview}
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
          />
          <p className="hint">Le commentaire devient instruction figée de l'itération suivante.</p>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={comment.trim() === '' || busy}
            title={comment.trim() === '' ? 'Commentaire obligatoire' : undefined}
            onClick={() => void doReturn()}
          >
            {busy ? 'Envoi…' : 'Renvoyer au coder'}
          </button>
        </div>

        <div className="review-action-row">
          <InlineConfirm
            label="Annuler la tâche"
            question="Annuler définitivement la tâche ?"
            onConfirm={doAbort}
            danger
          />
        </div>
      </section>
    </div>
  );
}
