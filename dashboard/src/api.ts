/**
 * Client REST du dashboard — miroir exact du contrat documenté dans src/core/types.ts.
 * Toute erreur HTTP est convertie en Error avec le message { error } du serveur.
 */

import type {
  StatusJson,
  OrchestratorEvent,
  RoueConfig,
  TaskCreateRequest,
  DiffReview,
} from '../../src/core/types';

/** Appel fetch typé : parse JSON, convertit { error } en exception lisible. */
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('serveur injoignable — le serveur roue-libre est-il lancé ?');
  }
  const text = await res.text();
  let json: unknown = null;
  if (text !== '') {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!res.ok) {
    const message =
      json !== null && typeof json === 'object' && 'error' in json
        ? String((json as { error: unknown }).error)
        : `erreur HTTP ${res.status}`;
    throw new Error(message);
  }
  return json as T;
}

function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function fetchStatus(): Promise<StatusJson | null> {
  return request<StatusJson | null>('/api/status');
}

export function fetchEvents(limit = 500): Promise<OrchestratorEvent[]> {
  return request<OrchestratorEvent[]>(`/api/events?limit=${limit}`);
}

export function fetchConfig(): Promise<RoueConfig> {
  return request<RoueConfig>('/api/config');
}

export function saveConfig(patch: Partial<RoueConfig>): Promise<RoueConfig> {
  return request<RoueConfig>('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function createTask(req: TaskCreateRequest): Promise<{ spec_preview: string }> {
  return post<{ spec_preview: string }>('/api/task', req);
}

export function confirmTask(): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/task/confirm');
}

export function actionMerge(): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/actions/merge');
}

export function actionAbort(): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/actions/abort');
}

export function actionRetry(): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/actions/retry');
}

export function actionReturn(comment: string): Promise<{ ok: true }> {
  return post<{ ok: true }>('/api/actions/return', { comment });
}

export function fetchDiff(): Promise<DiffReview> {
  return request<DiffReview>('/api/diff');
}
