/**
 * copy-fixtures — Vite plugin that copies demo/fixtures/* into
 * dist/demo/fixtures/* after `vite build`, so the deployed demo can
 * fetch them at /demo/fixtures/... URLs.
 *
 * No-op if the fixtures directory doesn't exist yet (fresh setup).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export function copyFixturesPlugin() {
  return {
    name: 'timelens-copy-fixtures',
    apply: 'build',
    closeBundle() {
      // When called from a Vite config in demo/, process.cwd() is demo/.
      const fixturesSrc = path.resolve(process.cwd(), 'fixtures');
      if (!fs.existsSync(fixturesSrc)) {
        console.log('[copy-fixtures] no fixtures dir at', fixturesSrc, '— skipping');
        return;
      }
      const dest = path.resolve(process.cwd(), 'dist', 'demo', 'fixtures');
      try {
        copyDirSync(fixturesSrc, dest);
        const count = fs.readdirSync(dest).length;
        console.log(`[copy-fixtures] copied ${count} entries to ${dest}`);
      } catch (err) {
        console.warn(`[copy-fixtures] copy failed: ${err.message}`);
      }
    },
  };
}