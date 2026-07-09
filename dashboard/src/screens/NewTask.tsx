/**
 * Écran 2 — Création de tâche : description, projet auto-détecté, critère de
 * succès OBLIGATOIRE, niveau de risque, génération d'aperçu de spec figée,
 * confirmation explicite avant lancement du pipeline.
 */

import { useEffect, useState } from 'react';
import type { StatusJson, RiskLevel } from '../../../src/core/types';
import type { TabId } from '../App';
import { createTask, confirmTask } from '../api';

interface Props {
  status: StatusJson | null;
  onNavigate: (tab: TabId) => void;
}

const RISK_OPTIONS: { value: RiskLevel; label: string }[] = [
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Élevé' },
];

export function NewTask({ status, onNavigate }: Props) {
  const [description, setDescription] = useState('');
  const [project, setProject] = useState('');
  const [criterion, setCriterion] = useState('');
  const [risk, setRisk] = useState<RiskLevel>('medium');
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pré-remplissage du projet depuis le statut courant (une seule fois, sans écraser une saisie).
  useEffect(() => {
    if (project === '' && status?.project) {
      setProject(status.project);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.project]);

  const criterionEmpty = criterion.trim() === '';
  const canGenerate = !criterionEmpty && description.trim() !== '' && !busy;
  const canLaunch = preview !== null && confirmed && !busy;

  const generate = async () => {
    setBusy(true);
    setError(null);
    setPreview(null);
    setConfirmed(false);
    try {
      const res = await createTask({
        description: description.trim(),
        success_criterion: criterion.trim(),
        risk_level: risk,
        project: project.trim() === '' ? undefined : project.trim(),
      });
      setPreview(res.spec_preview);
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
        </div>
      </section>

      {preview !== null && (
        <section className="card">
          <h3 className="card-title">Aperçu de spec.md</h3>
          <pre className="spec-preview">{preview}</pre>
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

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
