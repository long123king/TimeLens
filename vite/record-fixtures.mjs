/**
 * record-fixtures — Vite plugin that wraps the existing /api proxy and
 * persists every response under demo/fixtures/ as JSON.
 *
 * Activation:
 *   RECORD_FIXTURES=1 npm run dev
 *
 * Behavior:
 * - Reads the same route templates as MockBackend uses, so producer
 *   and consumer stay symmetric.
 * - Skips /server/status to avoid noise (called every 15s).
 * - Writes a sibling _meta.json per fixture capturing route, params,
 *   content-type, and capture timestamp.
 * - Overwrites existing fixtures (capture is idempotent).
 *
 * The dk server is expected to be reachable at the proxy target
 * configured in demo/vite.config.js (when added). For now, the
 * canonical proxy target lives in the repo-root vite.config.js.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROUTE_TEMPLATES,
  SKIP_ROUTES,
  parseUrl,
  resolveTemplate,
} from './route-templates.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function recordFixturesPlugin({ fixturesDir } = {}) {
  const baseDir = fixturesDir || path.resolve(__dirname, '..', 'demo', 'fixtures');
  const captureLog = [];
  const seen = new Set();

  return {
    name: 'timelens-record-fixtures',
    configureServer(server) {
      if (!process.env.RECORD_FIXTURES) return;

      // We attach a middleware that runs *after* the proxy chain.
      // It captures both the request URL (post-proxy-resolution) and
      // the upstream response body by re-issuing the same request.
      //
      // In practice, the existing /api proxy is configured in the
      // root vite.config.js. This middleware observes proxied
      // responses via the http.Server 'response' event. Simpler
      // approach: hook server.middlewares after the proxy.

      server.middlewares.use('/api', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        if (SKIP_ROUTES.has(`GET ${req.url.split('?')[0]}`)) return next();
        // Stash the request URL and let the rest of the chain run.
        const url = req.url;
        const capturedAt = new Date().toISOString();
        res.on('finish', () => {
          try {
            const { path: p, params } = parseUrl(url);
            const key = `GET ${p}`;
            const tpl = ROUTE_TEMPLATES[key];
            if (!tpl) return;
            const resolved = resolveTemplate(tpl, params);
            const filePath = path.join(baseDir, resolved);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });

            // Re-fetch upstream to capture the body for file write.
            // We use the response status from the original request.
            // To get the body, we patch res.write/res.end — too brittle
            // here. Instead we re-issue the request via the proxy target.
            const proxyTarget = server.config?.server?.proxy?.['/api']?.target
              || process.env.DK_TARGET
              || 'http://127.0.0.1:8080';
            const fullUrl = `${proxyTarget}${url}`;
            const upstream = server.httpServer?.httpClient
              ? null // not used
              : null;
            // Use built-in fetch (Node 18+).
            fetch(fullUrl, { method: 'GET' })
              .then(async (r) => {
                if (!r.ok) return;
                const buf = Buffer.from(await r.arrayBuffer());
                fs.writeFileSync(filePath, buf);
                const meta = {
                  route: key,
                  template: tpl,
                  params,
                  contentType: r.headers.get('content-type') || '',
                  capturedAt,
                  bytes: buf.length,
                };
                fs.writeFileSync(`${filePath}.meta.json`, JSON.stringify(meta, null, 2));
                if (!seen.has(resolved)) {
                  seen.add(resolved);
                  captureLog.push(resolved);
                  console.log(`[rec] ${key} → ${resolved} (${buf.length} bytes)`);
                }
              })
              .catch((err) => {
                console.warn(`[rec] upstream fetch failed for ${url}: ${err.message}`);
              });
          } catch (err) {
            console.warn(`[rec] capture error for ${req.url}: ${err.message}`);
          }
        });
        next();
      });

      server.httpServer?.once('listening', () => {
        console.log('[rec] Fixture recording active. Suggested click path:');
        console.log('       1. Wait for Home view (status, trace-info, modules, threads).');
        console.log('       2. Timeline; zoom 2-3 times; scrub a few positions.');
        console.log('       3. Memory Layout tab.');
        console.log('       4. Click "View in PE" on a module.');
        console.log('       5. Page Memory tab; navigate to a code page.');
        console.log('       6. Page Memory tab (SVG view).');
        console.log('       7. Function Calls tab; search a function.');
        console.log('       8. Strings tab; search a string.');
        console.log('       9. FlameGraph tab.');
        console.log('      10. Position tab; enter major:minor; switch threads.');
        console.log('      11. Command tab; run one command.');
      });

      // On shutdown, write the manifest.
      const writeManifest = () => {
        try {
          const positions = new Set();
          const addresses = new Set();
          const files = [];
          const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) walk(full);
              else if (entry.name.endsWith('.json') || entry.name.endsWith('.svg')) {
                if (entry.name.endsWith('.meta.json')) continue;
                files.push(path.relative(baseDir, full));
                const m = path.basename(entry.name).match(/^(\d+)_(\d+)/);
                if (m) positions.add(`${m[1]}:${m[2]}`);
                const am = path.basename(entry.name).match(/^(0x[0-9A-Fa-f]+)/);
                if (am) addresses.add(am[1]);
              }
            }
          };
          if (fs.existsSync(baseDir)) walk(baseDir);

          const manifest = {
            version: 1,
            capturedAt: new Date().toISOString(),
            positions: [...positions].sort((a, b) => {
              const [am, an] = a.split(':').map(Number);
              const [bm, bn] = b.split(':').map(Number);
              return am - bm || an - bn;
            }),
            addresses: [...addresses],
            routes: ROUTE_TEMPLATES,
            missingStrategy: 'fallbackToFirst',
            stopServer: { toast: 'Demo only — server stop is simulated.', toastType: 'info' },
            capturedFiles: files.length,
          };
          fs.writeFileSync(
            path.join(baseDir, 'manifest.json'),
            JSON.stringify(manifest, null, 2),
          );
          console.log(`[rec] Manifest written: ${files.length} files, ${positions.size} positions, ${addresses.size} addresses`);
        } catch (err) {
          console.warn(`[rec] manifest write failed: ${err.message}`);
        }
      };

      process.on('SIGINT', () => { writeManifest(); process.exit(0); });
      process.on('SIGTERM', () => { writeManifest(); process.exit(0); });
    },
  };
}