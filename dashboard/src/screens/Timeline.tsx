/**
 * Écran 3 — Timeline : flux chronologique de tous les événements (plus récent
 * en haut), filtre par rôle, lignes expansibles avec détail complet en <pre>.
 * Les 'chunk' consécutifs d'un même rôle sont regroupés et atténués.
 */

import { useMemo, useState } from 'react';
import type { OrchestratorEvent, RoleName, Stage } from '../../../src/core/types';
import {
  STAGE_LABELS,
  ALERT_LABELS,
  ROLE_LABELS,
  EVENT_TYPE_LABELS,
  clockTime,
  eventExcerpt,
  eventMarker,
} from '../format';
import type { AlertType } from '../../../src/core/types';

interface Props {
  events: OrchestratorEvent[];
}

type RoleFilter = 'all' | RoleName | 'engine';

const FILTERS: { value: RoleFilter; label: string }[] = [
  { value: 'all', label: 'Tous' },
  { value: 'prompteur', label: 'Prompteur' },
  { value: 'coder', label: 'Coder' },
  { value: 'testeur', label: 'Testeur' },
  { value: 'engine', label: 'Moteur' },
];

/** Élément d'affichage : événement seul, ou groupe de chunks consécutifs. */
type TimelineItem =
  | { kind: 'event'; event: OrchestratorEvent }
  | { kind: 'chunks'; id: string; role: RoleName | null; events: OrchestratorEvent[] };

/** Regroupe les 'chunk' consécutifs (même rôle) — un item compact au lieu d'une ligne par chunk. */
function buildItems(events: OrchestratorEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const e of events) {
    if (e.type === 'chunk') {
      const last = items[items.length - 1];
      if (last && last.kind === 'chunks' && last.role === e.role) {
        last.events.push(e);
      } else {
        items.push({ kind: 'chunks', id: `chunks-${e.id}`, role: e.role, events: [e] });
      }
    } else {
      items.push({ kind: 'event', event: e });
    }
  }
  return items;
}

/** Détail complet d'un événement : champs connus mis en avant, sinon data brute. */
function EventDetail({ event }: { event: OrchestratorEvent }) {
  const d = event.data;
  const sections: { title: string; content: string }[] = [];

  if (typeof d.prompt === 'string') sections.push({ title: 'Prompt exact envoyé', content: d.prompt });
  if (typeof d.result === 'string') sections.push({ title: 'Sortie complète', content: d.result });
  if (typeof d.stdout === 'string' && d.stdout.trim() !== '') sections.push({ title: 'stdout', content: d.stdout });
  if (typeof d.stderr === 'string' && d.stderr.trim() !== '') sections.push({ title: 'stderr', content: d.stderr });
  if (typeof d.from === 'string' && typeof d.to === 'string') {
    const fromLabel = STAGE_LABELS[d.from as Stage] ?? d.from;
    const toLabel = STAGE_LABELS[d.to as Stage] ?? d.to;
    sections.push({ title: 'Transition', content: `${fromLabel} (${d.from}) → ${toLabel} (${d.to})` });
  }
  if (typeof d.type === 'string' && d.type in ALERT_LABELS) {
    sections.push({ title: "Type d'alerte", content: ALERT_LABELS[d.type as AlertType] });
  }
  if (typeof d.comment === 'string') sections.push({ title: 'Commentaire', content: d.comment });

  return (
    <div className="event-detail">
      {sections.map((s) => (
        <div key={s.title} className="event-detail-section">
          <span className="label">{s.title}</span>
          <pre className="detail-pre">{s.content}</pre>
        </div>
      ))}
      <div className="event-detail-section">
        <span className="label">Data complète</span>
        <pre className="detail-pre">{JSON.stringify(d, null, 2)}</pre>
      </div>
    </div>
  );
}

export function Timeline({ events }: Props) {
  const [filter, setFilter] = useState<RoleFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const items = useMemo(() => {
    const filtered =
      filter === 'all'
        ? events
        : events.filter((e) => (filter === 'engine' ? e.role === null : e.role === filter));
    // Regroupement en ordre chronologique, puis inversion : plus récent en haut.
    return buildItems(filtered).reverse();
  }, [events, filter]);

  return (
    <div className="screen">
      <div className="screen-head">
        <h2 className="screen-title">Timeline</h2>
        <div className="filter-group" role="group" aria-label="Filtre par rôle">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`filter-btn${filter === f.value ? ' filter-active' : ''}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="muted empty-state">Aucun événement pour l'instant.</p>
      ) : (
        <ul className="timeline">
          {items.map((item) => {
            if (item.kind === 'chunks') {
              const open = expanded.has(item.id);
              const first = item.events[0];
              return (
                <li key={item.id} className="timeline-row timeline-chunks">
                  <button type="button" className="timeline-line" onClick={() => toggle(item.id)}>
                    <span className="marker marker-muted">·</span>
                    <span className="event-type">
                      {item.events.length} chunk{item.events.length > 1 ? 's' : ''}
                    </span>
                    <span className="event-role">{item.role ? ROLE_LABELS[item.role] : 'Moteur'}</span>
                    <span className="event-excerpt">{eventExcerpt(first)}</span>
                    <span className="event-time">{clockTime(first.at)}</span>
                  </button>
                  {open && (
                    <div className="event-detail">
                      <pre className="detail-pre">
                        {item.events
                          .map((e) => (typeof e.data.raw === 'string' ? e.data.raw : JSON.stringify(e.data)))
                          .join('\n')}
                      </pre>
                    </div>
                  )}
                </li>
              );
            }

            const e = item.event;
            const open = expanded.has(e.id);
            const { symbol, className } = eventMarker(e);
            return (
              <li key={e.id} className="timeline-row">
                <button type="button" className="timeline-line" onClick={() => toggle(e.id)}>
                  <span className={`marker ${className}`}>{symbol}</span>
                  <span className="event-type">{EVENT_TYPE_LABELS[e.type]}</span>
                  <span className="event-role">{e.role ? ROLE_LABELS[e.role] : 'Moteur'}</span>
                  <span className="event-excerpt">{eventExcerpt(e)}</span>
                  <span className="event-time">{clockTime(e.at)}</span>
                </button>
                {open && <EventDetail event={e} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
