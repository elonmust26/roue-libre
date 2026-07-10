/**
 * Bouton avec confirmation inline (pas de modale) :
 * 1er clic → affiche la question + Confirmer / Annuler à côté du bouton.
 *
 * Règle issue du bug v0.1 « clic sans effet » : un bouton désactivé affiche
 * sa raison EN CLAIR à côté de lui (pas seulement en info-bulle), et l'action
 * en cours a un libellé de chargement explicite.
 */

import { useState } from 'react';

interface Props {
  /** Libellé du bouton initial. */
  label: string;
  /** Question de confirmation (ex : « Confirmer le merge ? »). */
  question: string;
  onConfirm: () => void | Promise<void>;
  disabled?: boolean;
  /** Style danger (rouge) au lieu du style primaire. */
  danger?: boolean;
  /** Raison affichée à côté du bouton quand il est désactivé. */
  disabledReason?: string;
  /** Libellé pendant l'exécution de l'action (défaut : « En cours… »). */
  busyLabel?: string;
}

export function InlineConfirm({ label, question, onConfirm, disabled, danger, disabledReason, busyLabel }: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };

  if (asking) {
    return (
      <span className="inline-confirm">
        <span className="inline-confirm-question">{question}</span>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? (busyLabel ?? 'En cours…') : 'Confirmer'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsking(false)}>
          Annuler
        </button>
      </span>
    );
  }

  return (
    <span className="inline-confirm">
      <button
        type="button"
        className={danger ? 'btn btn-danger' : 'btn btn-primary'}
        disabled={disabled}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>
      {disabled && disabledReason && (
        <span className="inline-confirm-reason" role="note">{disabledReason}</span>
      )}
    </span>
  );
}
