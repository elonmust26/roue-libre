/**
 * Bouton avec confirmation inline (pas de modale) :
 * 1er clic → affiche la question + Confirmer / Annuler à côté du bouton.
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
  /** Info-bulle expliquant pourquoi le bouton est désactivé. */
  disabledReason?: string;
}

export function InlineConfirm({ label, question, onConfirm, disabled, danger, disabledReason }: Props) {
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
          {busy ? '…' : 'Confirmer'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setAsking(false)}>
          Annuler
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      className={danger ? 'btn btn-danger' : 'btn btn-primary'}
      disabled={disabled}
      title={disabled && disabledReason ? disabledReason : undefined}
      onClick={() => setAsking(true)}
    >
      {label}
    </button>
  );
}
