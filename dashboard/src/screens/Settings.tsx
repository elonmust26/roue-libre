/**
 * Écran 6 — Paramètres : presets un-clic (Éco / Standard / Max), seuils
 * (itérations, timeout, budget), risque par défaut, port, notifications de
 * fin d'étape, et par rôle : modèle Claude + niveau d'effort + allowlist.
 */

import { useEffect, useState } from 'react';
import type { RoueConfig, RoleName, RiskLevel, EffortLevel } from '../../../src/core/types';
import { fetchConfig, saveConfig } from '../api';
import { ROLE_LABELS } from '../format';
import { notificationsEnabled, setNotificationsEnabled, requestNotificationPermission } from '../notify';

const ROLES: RoleName[] = ['prompteur', 'coder', 'testeur'];

const RISK_OPTIONS: { value: RiskLevel; label: string }[] = [
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Élevé' },
];

/** Modèles Claude proposés (valeur libre possible via « Autre »). */
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — économique et rapide' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5 — équilibré' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8 — puissant' },
  { value: 'claude-fable-5', label: 'Fable 5 — le plus capable' },
];

const EFFORT_OPTIONS: { value: EffortLevel; label: string }[] = [
  { value: 'low', label: 'Économe — réflexion étendue désactivée' },
  { value: 'medium', label: 'Standard — défaut de la CLI' },
  { value: 'high', label: 'Élevé — budget de réflexion maximal' },
];

/** Presets un-clic : modèle + effort pour les 3 rôles, et budget de tâche. */
interface Preset {
  id: 'eco' | 'standard' | 'max';
  label: string;
  hint: string;
  model: string;
  effort: EffortLevel;
  budget_usd: number;
}

const PRESETS: Preset[] = [
  {
    id: 'eco',
    label: 'Éco',
    hint: 'Haiku partout · réflexion minimale · budget 2 $',
    model: 'claude-haiku-4-5-20251001',
    effort: 'low',
    budget_usd: 2,
  },
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Sonnet partout · effort standard · budget 5 $',
    model: 'claude-sonnet-5',
    effort: 'medium',
    budget_usd: 5,
  },
  {
    id: 'max',
    label: 'Max',
    hint: 'Fable partout · effort élevé · budget 20 $',
    model: 'claude-fable-5',
    effort: 'high',
    budget_usd: 20,
  },
];

function isKnownModel(model: string): boolean {
  return MODEL_OPTIONS.some((o) => o.value === model);
}

export function Settings() {
  const [config, setConfig] = useState<RoueConfig | null>(null);
  /** allowlists éditées en textarea (un outil par ligne), par rôle. */
  const [allowlists, setAllowlists] = useState<Record<RoleName, string>>({
    prompteur: '',
    coder: '',
    testeur: '',
  });
  /** Rôles en saisie libre de modèle (option « Autre »). */
  const [customModel, setCustomModel] = useState<Record<RoleName, boolean>>({
    prompteur: false,
    coder: false,
    testeur: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [notify, setNotify] = useState(notificationsEnabled());
  const [notifyStatus, setNotifyStatus] = useState<string | null>(null);

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
        setCustomModel({
          prompteur: !isKnownModel(c.roles.prompteur.model),
          coder: !isKnownModel(c.roles.coder.model),
          testeur: !isKnownModel(c.roles.testeur.model),
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

  const patchRole = (role: RoleName, patch: Partial<RoueConfig['roles'][RoleName]>) => {
    setConfig({
      ...config,
      roles: { ...config.roles, [role]: { ...config.roles[role], ...patch } },
    });
  };

  /** Sauvegarde d'une config donnée (reconstruit les allowlists depuis les textareas). */
  const persist = async (base: RoueConfig, toastLabel: string) => {
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const roles = { ...base.roles };
      for (const role of ROLES) {
        roles[role] = {
          ...roles[role],
          allowedTools: allowlists[role]
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== ''),
        };
      }
      const next = await saveConfig({ ...base, roles });
      setConfig(next);
      setAllowlists({
        prompteur: next.roles.prompteur.allowedTools.join('\n'),
        coder: next.roles.coder.allowedTools.join('\n'),
        testeur: next.roles.testeur.allowedTools.join('\n'),
      });
      setCustomModel({
        prompteur: !isKnownModel(next.roles.prompteur.model),
        coder: !isKnownModel(next.roles.coder.model),
        testeur: !isKnownModel(next.roles.testeur.model),
      });
      setSaved(toastLabel);
      window.setTimeout(() => setSaved(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  /** Preset un-clic : applique modèle + effort aux 3 rôles + budget, et ENREGISTRE. */
  const applyPreset = (preset: Preset) => {
    const roles = { ...config.roles };
    for (const role of ROLES) {
      roles[role] = { ...roles[role], model: preset.model, effort: preset.effort };
    }
    void persist({ ...config, roles, budget_usd: preset.budget_usd }, `Préréglage ${preset.label} appliqué`);
  };

  const toggleNotifications = async () => {
    if (!notify) {
      const granted = await requestNotificationPermission();
      setNotificationsEnabled(true);
      setNotify(true);
      setNotifyStatus(
        granted
          ? 'Notifications desktop actives (review / blocked).'
          : 'Permission desktop refusée — un signal sonore sera utilisé à la place.',
      );
    } else {
      setNotificationsEnabled(false);
      setNotify(false);
      setNotifyStatus('Notifications désactivées.');
    }
  };

  return (
    <div className="screen screen-narrow">
      <h2 className="screen-title">Paramètres</h2>

      <section className="card form-card">
        <h3 className="card-title">Préréglages un-clic</h3>
        <p className="hint">Applique modèle + effort aux 3 rôles et ajuste le budget, puis enregistre immédiatement.</p>
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`preset-btn preset-${p.id}`}
              disabled={saving}
              onClick={() => applyPreset(p)}
            >
              <span className="preset-label">{p.label}</span>
              <span className="preset-hint">{p.hint}</span>
            </button>
          ))}
        </div>
      </section>

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

      <section className="card form-card">
        <h3 className="card-title">Notifications de fin d'étape</h3>
        <p className="hint">
          Notification desktop (ou signal sonore) quand une tâche atteint <strong>Revue</strong> (prête à
          valider) ou <strong>Bloqué</strong> (intervention requise). Tout reste local.
        </p>
        <div className="form-actions">
          <button type="button" className={notify ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => void toggleNotifications()}>
            {notify ? 'Désactiver les notifications' : 'Activer les notifications'}
          </button>
          {notifyStatus && <span className="save-toast">{notifyStatus}</span>}
        </div>
      </section>

      {ROLES.map((role) => (
        <section key={role} className="card form-card">
          <h3 className="card-title">Rôle — {ROLE_LABELS[role]}</h3>
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor={`st-model-${role}`}>Modèle Claude</label>
              <select
                id={`st-model-${role}`}
                value={customModel[role] ? '__custom__' : config.roles[role].model}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomModel({ ...customModel, [role]: true });
                  } else {
                    setCustomModel({ ...customModel, [role]: false });
                    patchRole(role, { model: e.target.value });
                  }
                }}
              >
                {MODEL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
                <option value="__custom__">Autre (saisie libre)…</option>
              </select>
              {customModel[role] && (
                <input
                  type="text"
                  className="mono custom-model-input"
                  aria-label={`Modèle personnalisé — ${ROLE_LABELS[role]}`}
                  value={config.roles[role].model}
                  onChange={(e) => patchRole(role, { model: e.target.value })}
                  placeholder="identifiant de modèle exact"
                />
              )}
              <p className="hint">
                si l'alias est refusé par la CLI, l'erreur exacte remonte telle quelle
                (console live du rôle + Timeline)
              </p>
            </div>
            <div className="field">
              <label className="label" htmlFor={`st-effort-${role}`}>Effort / réflexion</label>
              <select
                id={`st-effort-${role}`}
                value={config.roles[role].effort ?? 'medium'}
                onChange={(e) => patchRole(role, { effort: e.target.value as EffortLevel })}
              >
                {EFFORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
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
        <button type="button" className="btn btn-primary" disabled={saving} onClick={() => void persist(config, 'Enregistré')}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {saved && <span className="save-toast">{saved}</span>}
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
