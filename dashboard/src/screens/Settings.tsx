/**
 * Écran 6 — Paramètres : seuils (itérations, timeout, budget), risque par
 * défaut, port, et par rôle : modèle + allowlist d'outils (un par ligne).
 */

import { useEffect, useState } from 'react';
import type { RoueConfig, RoleName, RiskLevel } from '../../../src/core/types';
import { fetchConfig, saveConfig } from '../api';
import { ROLE_LABELS } from '../format';

const ROLES: RoleName[] = ['prompteur', 'coder', 'testeur'];

const RISK_OPTIONS: { value: RiskLevel; label: string }[] = [
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Élevé' },
];

export function Settings() {
  const [config, setConfig] = useState<RoueConfig | null>(null);
  /** allowlists éditées en textarea (un outil par ligne), par rôle. */
  const [allowlists, setAllowlists] = useState<Record<RoleName, string>>({
    prompteur: '',
    coder: '',
    testeur: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchConfig()
      .then((c) => {
        if (cancelled) return;
        setConfig(c);
        setAllowlists({
          prompteur: c.roles.prompteur.allowedTools.join('\n'),
          coder: c.roles.coder.allowedTools.join('\n'),
          testeur: c.roles.testeur.allowedTools.join('\n'),
        });
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (config === null) {
    return (
      <div className="screen screen-narrow">
        <h2 className="screen-title">Paramètres</h2>
        {error ? <div className="error-box" role="alert">{error}</div> : <p className="muted">Chargement…</p>}
      </div>
    );
  }

  const patchNumber = (key: 'max_iterations' | 'timeout_minutes' | 'budget_usd' | 'port', raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    setConfig({ ...config, [key]: value });
  };

  const patchRoleModel = (role: RoleName, model: string) => {
    setConfig({
      ...config,
      roles: { ...config.roles, [role]: { ...config.roles[role], model } },
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // Reconstitution des allowlists depuis les textareas (un outil par ligne).
      const roles = { ...config.roles };
      for (const role of ROLES) {
        roles[role] = {
          ...roles[role],
          allowedTools: allowlists[role]
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== ''),
        };
      }
      const next = await saveConfig({ ...config, roles });
      setConfig(next);
      setAllowlists({
        prompteur: next.roles.prompteur.allowedTools.join('\n'),
        coder: next.roles.coder.allowedTools.join('\n'),
        testeur: next.roles.testeur.allowedTools.join('\n'),
      });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen screen-narrow">
      <h2 className="screen-title">Paramètres</h2>

      <section className="card form-card">
        <h3 className="card-title">Seuils</h3>

        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="st-iter">Max itérations</label>
            <input
              id="st-iter"
              type="number"
              min={1}
              value={config.max_iterations}
              onChange={(e) => patchNumber('max_iterations', e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="st-timeout">Timeout par étape (minutes)</label>
            <input
              id="st-timeout"
              type="number"
              min={1}
              value={config.timeout_minutes}
              onChange={(e) => patchNumber('timeout_minutes', e.target.value)}
            />
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="st-budget">Budget $ par tâche</label>
            <input
              id="st-budget"
              type="number"
              min={0}
              step={0.5}
              value={config.budget_usd}
              onChange={(e) => patchNumber('budget_usd', e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="st-risk">Risque par défaut</label>
            <select
              id="st-risk"
              value={config.default_risk}
              onChange={(e) => setConfig({ ...config, default_risk: e.target.value as RiskLevel })}
            >
              {RISK_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="field">
          <label className="label" htmlFor="st-port">Port</label>
          <input
            id="st-port"
            type="number"
            min={1}
            max={65535}
            value={config.port}
            onChange={(e) => patchNumber('port', e.target.value)}
          />
          <p className="hint">effectif au prochain démarrage du serveur</p>
        </div>
      </section>

      {ROLES.map((role) => (
        <section key={role} className="card form-card">
          <h3 className="card-title">Rôle — {ROLE_LABELS[role]}</h3>
          <div className="field">
            <label className="label" htmlFor={`st-model-${role}`}>Modèle</label>
            <input
              id={`st-model-${role}`}
              type="text"
              value={config.roles[role].model}
              onChange={(e) => patchRoleModel(role, e.target.value)}
              placeholder="claude-fable-5"
            />
            <p className="hint">
              si l'alias est refusé par la CLI, l'erreur remontée s'affichera telle quelle dans la Timeline
            </p>
          </div>
          <div className="field">
            <label className="label" htmlFor={`st-tools-${role}`}>Allowlist d'outils (un par ligne)</label>
            <textarea
              id={`st-tools-${role}`}
              rows={5}
              className="mono"
              value={allowlists[role]}
              onChange={(e) => setAllowlists({ ...allowlists, [role]: e.target.value })}
            />
          </div>
        </section>
      ))}

      <div className="form-actions settings-actions">
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void save()}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {saved && <span className="save-toast">Enregistré</span>}
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
