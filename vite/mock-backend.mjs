/**
 * mock-backend — Vite plugin that serves the demo's fixtures under /api
 * for local development without WinDbg + dk.
 *
 * Activation:
 *   USE_MOCK=1 npm run dev
 *
 * Used inside demo/vite.config.js so a developer can iterate on the
 * UI without a running dk server.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_TEMPLATES,
  parseUrl,
  resolveTemplate,
} from './route-templates.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTE_PATHS = new Set(
  Object.keys(ROUTE_TEMPLATES).map((k) => k.substring(4)), // strip "GET "
);

function manifestFromRoutes() {
  return {
    version: 1,
    positions: [],
    addresses: [],
    routes: { ...ROUTE_TEMPLATES },
  };
}

export function mockBackendPlugin({ fixturesDir } = {}) {
  const baseDir = fixturesDir || path.resolve(__dirname, '..', 'demo', 'fixtures');
  const manifest = manifestFromRoutes();

  return {
    name: 'timelens-mock-backend',
    configureServer(server) {
      if (process.env.USE_MOCK !== '1') return;

      // PRE-middleware: register directly (not via a returned function) so
      // it runs BEFORE Vite's history-API fallback. Otherwise Vite rewrites
      // unknown paths to /index.html and our handler never sees /api/*.
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== 'GET') return next();
        // Vite with base: '/TimeLens/' leaves the base in the URL during dev,
        // so req.url may be /TimeLens/api/server/status. Strip the base first.
        let url = req.url || '';
        const base = server.config?.base || '/';
        if (base !== '/' && url.startsWith(base)) {
          url = url.substring(base.length - (base.endsWith('/') ? 1 : 0));
        }

        // Serve /demo/fixtures/* directly from disk so the manifest and
        // captured files are reachable without depending on Vite's static
        // handler (which the history-API fallback sometimes preempts).
        if (url.startsWith('/demo/fixtures/')) {
          const rel = url.substring('/demo/fixtures/'.length).split('?')[0];
          const filePath = path.join(baseDir, rel);
          // Prevent path traversal.
          if (!filePath.startsWith(baseDir)) return next();
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
          const ext = path.extname(filePath).toLowerCase();
          const ct = ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.json'
              ? 'application/json'
              : 'application/octet-stream';
          res.statusCode = 200;
          res.setHeader('content-type', ct);
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        if (!url.startsWith('/api/')) return next();
        // Strip /api prefix to get the route key (e.g., /server/status).
        const routePath = url.substring(4); // remove '/api'
        const { path: p, params } = parseUrl(routePath);
        if (!ROUTE_PATHS.has(p)) return next();

        const tpl = manifest.routes[`GET ${p}`];
        if (!tpl) return next();

        // Special-case /server/status: synthesize a live response so the
        // connection panel can show "online" with advancing uptime.
        if (p === '/server/status') {
          const body = {
            running: true,
            uptimeMs: Date.now() - (Number(process.env.DK_BOOT_AT) || Date.now()),
            demo: true,
          };
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
          return;
        }

        const resolved = resolveTemplate(tpl, params);
        const filePath = path.join(baseDir, resolved);

        // Small artificial latency so loading states render.
        const ms = 80 + Math.floor(Math.random() * 200);
        await new Promise((r) => setTimeout(r, ms));

        if (fs.existsSync(filePath)) {
          const ext = path.extname(filePath);
          const ct = ext === '.svg' ? 'image/svg+xml' : 'application/json';
          res.statusCode = 200;
          res.setHeader('content-type', ct);
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        // Fixture missing — return a 404 with structured error envelope
        // so callers can fall back gracefully.
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          error: {
            code: 'NO_FIXTURE',
            message: `Fixture not found: ${resolved}. Run a capture session (RECORD_FIXTURES=1) to populate.`,
          },
        }));
      });

      server.httpServer?.once('listening', () => {
        console.log(`[mock] Serving fixtures from ${baseDir}`);
      });
    },
  };
}