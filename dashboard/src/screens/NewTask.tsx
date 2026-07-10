/**
 * Écran 2 — Création de tâche : description, projet auto-détecté, critère de
 * succès OBLIGATOIRE, niveau de risque, génération d'aperçu de spec figée,
 * estimation de coût (dry-run) et confirmation explicite avant lancement.
 * v0.2 : file d'attente — empiler plusieurs tâches exécutées séquentiellement,
 * chacune produisant sa propre PR.
 */

import { useCallback, useEffect, useState } from 'react';
import type { StatusJson, RiskLevel, CostEstimate, QueuedTask } from '../../../src/core/types';
import type { TabId } from '../App';
import { createTask, confirmTask, fetchEstimate, fetchQueue, enqueueTask, removeQueuedTask } from '../api';

interface Props {
  status: StatusJson | null;
  onNavigate: (tab: TabId) => void;
}

const RISK_OPTIONS: { value: RiskLevel; label: string }[] = [
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Élevé' },
];

const RISK_LABELS: Record<RiskLevel, string> = { low: 'faible', medium: 'moyen', high: 'élevé' };

export function NewTask({ status, onNavigate }: Props) {
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [criterion, setCriterion] = useState('');
  const [risk, setRisk] = useState<RiskLevel>('medium');
  const [preview, setPreview] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // v0.2 — file d'attente.
  const [queue, setQueue] = useState<QueuedTask[]>([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueToast, setQueueToast] = useState<string | null>(null);

  // Pré-remplissage du projet depuis le statut courant (une seule fois, sans écraser une saisie).
  useEffect(() => {
    if (project === '' && status?.project) {
      setProject(status.project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.project]);

  const refreshQueue = useCallback(() => {
    fetchQueue()
      .then(setQueue)
      .catch(() => {
        /* file indisponible — la section reste vide, sans casser l'écran */
      });
  }, []);

  // File rechargée au montage et à chaque changement de stage (la file avance
  // automatiquement quand une tâche se termine).
  useEffect(() => {
    refreshQueue();
  }, [refreshQueue, status?.stage]);

  const criterionEmpty = criterion.trim() === '';
  const formFilled = !criterionEmpty && description.trim() !== '';
  const canGenerate = formFilled && !busy;
  const canLaunch = preview !== null && confirmed && !busy;

  const generate = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setEstimate(null);
    setConfirmed(false);
    try {
      const res = await createTask({
        description: description.trim(),
        success_criterion: criterion.trim(),
        risk_level: risk,
        project: project.trim() === '' ? undefined : project.trim(),
      });
      setPreview(res.spec_preview);
      // Estimation de coût AVANT lancement (dry-run) — grossière et assumée.
      try {
        setEstimate(await fetchEstimate());
      } catch {
        /* estimation indisponible — le lancement reste possible */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const launch = async () => {
    setBusy(true);
    setError(null);
    try {
      await confirmTask();
      onNavigate('dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const addToQueue = async () => {
    setQueueBusy(true);
    setError(null);
    setQueueToast(null);
    try {
      const next = await enqueueTask({
        description: description.trim(),
        success_criterion: criterion.trim(),
        risk_level: risk,
        project: project.trim() === '' ? undefined : project.trim(),
      });
      setQueue(next);
      setQueueToast('Tâche ajoutée à la file.');
      setDescription('');
      setCriterion('');
      setPreview(null);
      setEstimate(null);
      window.setTimeout(() => setQueueToast(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueBusy(false);
    }
  };

  const removeFromQueue = async (id: string) => {
    setQueueBusy(true);
    setError(null);
    try {
      setQueue(await removeQueuedTask(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setQueueBusy(false);
    }
  };

  return (
    <div className="screen screen-narrow">
      <h2 className="screen-title">Nouvelle tâche</h2>

      <section className="card form-card">
        <div className="field">
          <label className="label" htmlFor="nt-description">Description de la tâche</label>
          <textarea
            id="nt-description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Décrire ce qui doit être fait, le périmètre, le contexte utile…"
          />
        </div>

        <div className="field">
          <label className="label" htmlFor="nt-project">Projet</label>
          <input
            id="nt-project"
            type="text"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="nom-du-projet"
          />
          <p className="hint">auto-détecté via git remote / nom de dossier — modifiable</p>
        </div>

        <div className="field">
          <label className="label" htmlFor="nt-criterion">
            Critère de succès <span className="required">obligatoire</span>
          </label>
          <textarea
            id="nt-criterion"
            rows={3}
            value={criterion}
            onChange={(e) => setCriterion(e.target.value)}
            placeholder="Comment vérifier objectivement que la tâche est finie ?"
          />
          {criterionEmpty && (
            <p className="hint hint-warn">
              Pas de lancement sans définition claire de « fini » — le bouton Générer reste désactivé.
            </p>
          )}
        </div>

        <div className="field">
          <label className="label" htmlFor="nt-risk">Niveau de risque</label>
          <select id="nt-risk" value={risk} onChange={(e) => setRisk(e.target.value as RiskLevel)}>
            {RISK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <p className="hint">Moyen et Élevé : merge uniquement via validation manuelle.</p>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={!canGenerate} onClick={() => void generate()}>
            {busy && preview === null ? 'Génération…' : 'Générer la spec figée'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!formFilled || queueBusy}
            title={formFilled ? undefined : 'Description et critère de succès requis'}
            onClick={() => void addToQueue()}
          >
            {queueBusy ? 'Ajout…' : "Ajouter à la file d'attente"}
          </button>
          {queueToast && <span className="save-toast">{queueToast}</span>}
        </div>
      </section>

      {preview !== null && (
        <section className="card">
          <h3 className="card-title">Aperçu de spec.md</h3>
          <pre className="spec-preview">{preview}</pre>

          {estimate && (
            <div className={`estimate-box${estimate.over_budget ? ' estimate-over' : ''}`} role="note">
              <span className="estimate-icon" aria-hidden="true">{estimate.over_budget ? '⚠' : '≈'}</span>
              <span className="estimate-text">
                Coût estimé (grossier) : <strong>${estimate.estimated_usd.toFixed(2)}</strong> pour un
                budget de ${estimate.budget_usd.toFixed(2)} — base : {estimate.basis}.
                {estimate.over_budget &&
                  ' DÉPASSEMENT PROBABLE du budget configuré : augmente le budget ou réduis la spec.'}
                {' '}En mode --simulate, le coût réel est 0 $.
              </span>
            </div>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            Je confirme cette spec
          </label>
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canLaunch}
              title={canLaunch ? undefined : 'Générer la spec et cocher la confirmation d’abord'}
              onClick={() => void launch()}
            >
              Lancer le pipeline
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h3 className="card-title">File d'attente ({queue.length})</h3>
        {queue.length === 0 ? (
          <p className="muted">
            Aucune tâche en attente. Les tâches empilées s'exécutent séquentiellement dès que la
            tâche courante est terminée (mergée ou annulée), chacune produisant sa propre PR.
          </p>
        ) : (
          <ul className="queue-list">
            {queue.map((t, i) => (
              <li key={t.id} className="queue-item">
                <span className="queue-pos">{i + 1}</span>
                <span className="queue-desc">
                  {t.description}
                  <span className="queue-meta">risque {RISK_LABELS[t.risk_level]} · critère : {t.success_criterion}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={queueBusy}
                  onClick={() => void removeFromQueue(t.id)}
                >
                  Retirer
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
