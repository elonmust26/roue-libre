/**
 * Serveur local roue-libre : Express + WebSocket (ws) sur le MÊME serveur HTTP.
 * - API REST du contrat documenté dans src/core/types.ts
 * - WS sur /ws : push temps réel des événements et du statut (types WsMessage)
 * - Sert le dashboard buildé (dashboard/dist) ou une page de repli inline.
 * Outil strictement local : écoute sur 127.0.0.1 uniquement.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import type {
  ServerOptions,
  ServerHandle,
  TaskCreateRequest,
  RoueConfig,
  WsMessage,
  RiskLevel,
} from '../core/types.js';

/** Enveloppe un handler async : toute erreur jetée → réponse JSON d'erreur. */
function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, _next) => {
    fn(req, res).catch((err: unknown) => sendError(res, err));
  };
}

/**
 * Erreur → réponse JSON { error }. Les méthodes de l'orchestrateur qui jettent
 * (action invalide dans l'état courant, etc.) → 409 par convention du contrat.
 */
function sendError(res: Response, err: unknown, status = 409): void {
  const message = err instanceof Error ? err.message : String(err);
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
}

const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high'];

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { orchestrator } = opts;
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  /* ---------------------------------------------------------------- */
  /* API REST                                                          */
  /* ---------------------------------------------------------------- */

  app.get('/api/status', (_req, res) => {
    try {
      res.json(orchestrator.getStatus());
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  app.get(
    '/api/events',
    asyncHandler(async (req, res) => {
      const raw = req.query.limit;
      let limit = 200;
      if (typeof raw === 'string' && raw !== '') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          res.status(400).json({ error: 'paramètre limit invalide (entier positif attendu)' });
          return;
        }
        limit = Math.floor(parsed);
      }
      const events = await orchestrator.getEvents(limit);
      res.json(events);
    }),
  );

  app.get('/api/config', (_req, res) => {
    try {
      res.json(orchestrator.getConfig());
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  app.put(
    '/api/config',
    asyncHandler(async (req, res) => {
      const patch = req.body as Partial<RoueConfig> | undefined;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        res.status(400).json({ error: 'corps de requête invalide : objet Partial<RoueConfig> attendu' });
        return;
      }
      const config = await orchestrator.setConfig(patch);
      res.json(config);
    }),
  );

  app.post(
    '/api/task',
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<TaskCreateRequest> | undefined;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'corps de requête invalide : TaskCreateRequest attendu' });
        return;
      }
      if (typeof body.description !== 'string' || body.description.trim() === '') {
        res.status(400).json({ error: 'description obligatoire' });
        return;
      }
      if (typeof body.success_criterion !== 'string' || body.success_criterion.trim() === '') {
        res.status(400).json({ error: 'critère de succès obligatoire — pas de lancement sans définition claire de « fini »' });
        return;
      }
      if (!RISK_LEVELS.includes(body.risk_level as RiskLevel)) {
        res.status(400).json({ error: 'risk_level invalide (low | medium | high)' });
        return;
      }
      const preview = await orchestrator.createTask({
        description: body.description,
        success_criterion: body.success_criterion,
        risk_level: body.risk_level as RiskLevel,
        project: typeof body.project === 'string' && body.project.trim() !== '' ? body.project : undefined,
      });
      res.json(preview);
    }),
  );

  app.post(
    '/api/task/confirm',
    asyncHandler(async (_req, res) => {
      await orchestrator.confirmTask();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/actions/merge',
    asyncHandler(async (_req, res) => {
      await orchestrator.merge();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/actions/abort',
    asyncHandler(async (_req, res) => {
      await orchestrator.abort();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/actions/retry',
    asyncHandler(async (_req, res) => {
      await orchestrator.retry();
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/actions/return',
    asyncHandler(async (req, res) => {
      const body = req.body as { comment?: unknown } | undefined;
      const comment = body?.comment;
      if (typeof comment !== 'string' || comment.trim() === '') {
        res.status(400).json({ error: 'commentaire obligatoire pour renvoyer au coder' });
        return;
      }
      await orchestrator.returnToCoder(comment);
      res.json({ ok: true });
    }),
  );

  app.get(
    '/api/diff',
    asyncHandler(async (_req, res) => {
      const diff = await orchestrator.getDiff();
      res.json(diff);
    }),
  );

  /* ------------------------- v0.2 : file d'attente ------------------------- */

  app.get('/api/queue', (_req, res) => {
    try {
      res.json(orchestrator.getQueue());
    } catch (err) {
      sendError(res, err, 500);
    }
  });

  app.post(
    '/api/queue',
    asyncHandler(async (req, res) => {
      const body = req.body as Partial<TaskCreateRequest> | undefined;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'corps de requête invalide : TaskCreateRequest attendu' });
        return;
      }
      if (typeof body.description !== 'string' || body.description.trim() === '') {
        res.status(400).json({ error: 'description obligatoire' });
        return;
      }
      if (typeof body.success_criterion !== 'string' || body.success_criterion.trim() === '') {
        res.status(400).json({ error: 'critère de succès obligatoire — pas de lancement sans définition claire de « fini »' });
        return;
      }
      if (!RISK_LEVELS.includes(body.risk_level as RiskLevel)) {
        res.status(400).json({ error: 'risk_level invalide (low | medium | high)' });
        return;
      }
      const queue = await orchestrator.enqueueTask({
        description: body.description,
        success_criterion: body.success_criterion,
        risk_level: body.risk_level as RiskLevel,
        project: typeof body.project === 'string' && body.project.trim() !== '' ? body.project : undefined,
      });
      res.json(queue);
    }),
  );

  app.delete(
    '/api/queue/:id',
    asyncHandler(async (req, res) => {
      const queue = await orchestrator.removeQueuedTask(req.params.id);
      res.json(queue);
    }),
  );

  /* --------------------- v0.2 : estimation de coût ---------------------- */

  app.get(
    '/api/estimate',
    asyncHandler(async (_req, res) => {
      res.json(await orchestrator.estimateCost());
    }),
  );

  // Route API inconnue → 404 JSON (avant le fallback statique).
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'route API inconnue' });
  });

  /* ---------------------------------------------------------------- */
  /* Statique : dashboard buildé, ou page de repli inline              */
  /* ---------------------------------------------------------------- */

  const dist = opts.dashboardDist;
  if (dist && existsSync(join(dist, 'index.html'))) {
    app.use(express.static(dist));
    // Fallback SPA : toute route non-API renvoie index.html.
    app.get('*', (_req, res) => {
      res.sendFile(join(dist, 'index.html'));
    });
  } else {
    app.get('*', (_req, res) => {
      res
        .status(200)
        .type('html')
        .send(
          `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>roue-libre</title>
<style>body{background:#0b0e14;color:#e6e9f0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0}main{text-align:center}code{background:#1a2030;padding:2px 8px;border-radius:6px;font-family:ui-monospace,monospace}</style>
</head>
<body><main>
<h1>roue-libre</h1>
<p>dashboard non buildé — <code>npm run build:dashboard</code></p>
<p>L'API REST reste disponible sous <code>/api/*</code> et le WebSocket sous <code>/ws</code>.</p>
</main></body>
</html>`,
        );
    });
  }

  /* ---------------------------------------------------------------- */
  /* HTTP + WebSocket sur le même serveur                              */
  /* ---------------------------------------------------------------- */

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  /** Envoie un WsMessage à un client si le socket est ouvert. */
  function send(socket: WebSocket, message: WsMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  /** Diffuse un WsMessage à tous les clients connectés. */
  function broadcast(message: WsMessage): void {
    const payload = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  // Relais temps réel : événements et statut de l'orchestrateur → tous les clients.
  const unsubscribeEvent = orchestrator.onEvent((event) => {
    broadcast({ kind: 'event', event });
  });
  const unsubscribeStatus = orchestrator.onStatus((status) => {
    broadcast({ kind: 'status', status });
  });

  wss.on('connection', (socket) => {
    // À la connexion : statut courant immédiat.
    send(socket, { kind: 'status', status: orchestrator.getStatus() });
    // Désabonnement propre : rien à désabonner par client (abonnements globaux),
    // mais on ignore les erreurs de socket pour ne pas faire tomber le serveur.
    socket.on('error', () => {
      /* socket client défaillant — ignoré, la fermeture suit */
    });
  });

  // Démarrage : 127.0.0.1 uniquement (outil local). Port pris → erreur claire.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`le port ${opts.port} est déjà utilisé — libérez-le ou changez le port dans les Paramètres (roue.config.json)`));
      } else {
        reject(err);
      }
    };
    httpServer.once('error', onError);
    httpServer.listen(opts.port, '127.0.0.1', () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  let closed = false;
  return {
    port: opts.port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // 1. Désabonnement des flux orchestrateur.
      unsubscribeEvent();
      unsubscribeStatus();
      // 2. Fermeture des clients WS puis du serveur WS.
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // 3. Fermeture du serveur HTTP.
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
