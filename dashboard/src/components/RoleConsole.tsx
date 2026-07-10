/**
 * v0.2 — Console live d'un rôle : mini-terminal en lecture seule alimenté par
 * les événements du WebSocket (stream-json déjà capté par le moteur).
 * Objectif : voir les 3 rôles travailler sur un seul écran, sans tmux.
 * Monospace, défilement automatique, couleur par type de ligne.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { OrchestratorEvent, RoleName } from '../../../src/core/types';

interface Props {
  role: RoleName;
  events: OrchestratorEvent[];
}

/** Ligne de console typée (la classe CSS porte la couleur). */
interface ConsoleLine {
  id: string;
  kind: 'cmd' | 'sys' | 'out' | 'result' | 'gate-ok' | 'gate-ko' | 'err';
  text: string;
}

/** Extrait le texte assistant d'un chunk stream-json (best effort). */
function assistantText(parsed: Record<string, unknown>): string {
  const message = parsed.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
  if (!message?.content) return '';
  return message.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Transforme les événements d'un rôle en lignes de console. */
function buildLines(role: RoleName, events: OrchestratorEvent[]): ConsoleLine[] {
  const lines: ConsoleLine[] = [];
  for (const e of events) {
    if (e.role !== role) continue;
    switch (e.type) {
      case 'prompt_sent': {
        const prompt = typeof e.data.prompt === 'string' ? e.data.prompt : '';
        const model = typeof e.data.model === 'string' ? e.data.model : '?';
        lines.push({
          id: e.id,
          kind: 'cmd',
          text: `→ prompt envoyé — ${prompt.length.toLocaleString('fr-FR')} caractères · modèle ${model}`,
        });
        break;
      }
      case 'chunk': {
        const parsed = (e.data.parsed ?? null) as Record<string, unknown> | null;
        if (!parsed) {
          const raw = typeof e.data.raw === 'string' ? e.data.raw : '';
          if (raw.trim()) lines.push({ id: e.id, kind: 'out', text: raw });
          break;
        }
        if (parsed.type === 'system') {
          const model = typeof parsed.model === 'string' ? parsed.model : '?';
          lines.push({ id: e.id, kind: 'sys', text: `▸ session ouverte (${model})` });
        } else if (parsed.type === 'assistant') {
          const text = assistantText(parsed);
          if (text.trim()) lines.push({ id: e.id, kind: 'out', text });
        } else if (parsed.type === 'result') {
          const cost = typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null;
          lines.push({
            id: e.id,
            kind: 'result',
            text: `■ résultat rendu${cost !== null ? ` — $${cost.toFixed(2)}` : ''}`,
          });
        }
        break;
      }
      case 'role_result': {
        const ok = e.data.ok === true;
        const exit = typeof e.data.exit_code === 'number' ? e.data.exit_code : '?';
        const stderr = typeof e.data.stderr === 'string' ? e.data.stderr : '';
        lines.push({
          id: e.id,
          kind: ok ? 'result' : 'err',
          text: ok ? `✓ run terminé (exit ${exit})` : `✗ run échoué (exit ${exit})`,
        });
        // L'erreur exacte de la CLI (modèle refusé…) — affichée telle quelle.
        if (stderr.trim()) lines.push({ id: `${e.id}-stderr`, kind: 'err', text: stderr });
        break;
      }
      case 'gate_passed':
        lines.push({ id: e.id, kind: 'gate-ok', text: '✓ gate passée' });
        break;
      case 'gate_failed':
        lines.push({ id: e.id, kind: 'gate-ko', text: '✗ gate échouée' });
        break;
      default:
        break;
    }
  }
  return lines;
}

export function RoleConsole({ role, events }: Props) {
  const lines = useMemo(() => buildLines(role, events), [role, events]);
  const viewRef = useRef<HTMLDivElement | null>(null);

  // Défilement automatique vers la dernière ligne à chaque nouvel événement.
  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <div ref={viewRef} className="role-console" role="log" aria-label={`Console ${role}`}>
      {lines.length === 0 ? (
        <span className="console-line console-sys">— aucun flux pour l'instant —</span>
      ) : (
        lines.map((l) => (
          <span key={l.id} className={`console-line console-${l.kind}`}>
            {l.text}
            {'\n'}
          </span>
        ))
      )}
    </div>
  );
}
