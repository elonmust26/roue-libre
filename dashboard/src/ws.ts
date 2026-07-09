/**
 * useOrchestrator — état global temps réel du dashboard.
 * WebSocket vers /ws avec reconnexion automatique (backoff exponentiel plafonné) ;
 * à chaque (re)connexion : refetch GET /api/status + /api/events pour resynchroniser.
 */

import { useEffect, useState } from 'react';
import type { StatusJson, OrchestratorEvent, WsMessage } from '../../src/core/types';
import { fetchStatus, fetchEvents } from './api';

export interface OrchestratorState {
  status: StatusJson | null;
  /** Événements dédupliqués par id, triés chronologiquement (plus ancien en premier). */
  events: OrchestratorEvent[];
  /** true si le WebSocket est actuellement ouvert. */
  connected: boolean;
}

/** Fusionne des événements entrants dans la liste existante (dédup par id, tri par date). */
function mergeEvents(
  prev: OrchestratorEvent[],
  incoming: OrchestratorEvent[],
): OrchestratorEvent[] {
  const byId = new Map<string, OrchestratorEvent>();
  for (const e of prev) byId.set(e.id, e);
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function useOrchestrator(): OrchestratorState {
  const [status, setStatus] = useState<StatusJson | null>(null);
  const [events, setEvents] = useState<OrchestratorEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempts = 0;
    let reconnectTimer: number | undefined;

    /** Resynchronisation complète via REST (au connect et à chaque reconnect). */
    const resync = async (): Promise<void> => {
      try {
        const [s, evts] = await Promise.all([fetchStatus(), fetchEvents(500)]);
        if (disposed) return;
        setStatus(s);
        setEvents((prev) => mergeEvents(prev, evts));
      } catch {
        // Serveur momentanément injoignable — la boucle de reconnexion WS réessaiera.
      }
    };

    const connect = (): void => {
      if (disposed) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${window.location.host}/ws`);

      socket.onopen = () => {
        attempts = 0;
        setConnected(true);
        void resync();
      };

      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as WsMessage;
          if (msg.kind === 'status') {
            setStatus(msg.status);
          } else if (msg.kind === 'event') {
            setEvents((prev) => mergeEvents(prev, [msg.event]));
          }
        } catch {
          // Message illisible — ignoré.
        }
      };

      socket.onclose = () => {
        if (disposed) return;
        setConnected(false);
        // Backoff exponentiel : 1s, 2s, 4s… plafonné à 15s.
        const delay = Math.min(1000 * 2 ** attempts, 15000);
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => {
        // L'erreur déclenche onclose → la reconnexion est gérée là-bas.
        socket?.close();
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return { status, events, connected };
}
