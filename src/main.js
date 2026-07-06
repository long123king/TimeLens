import { Application } from 'pixi.js';
import App from './core/App.js';
import './styles/main.css';

const BASE_URL = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const DEPLOY_TARGET = typeof __DEPLOY_TARGET__ !== 'undefined' ? __DEPLOY_TARGET__ : 'dev';
const BUNDLED_STORYLINE_NAME = 'storyline-1783342659893.storyline.json';

let pendingArchive = null;
const dropZone = () => document.getElementById('replay-dropzone');

function isStorylineFile(name) {
  return /\.storyline\.json$|\.json$/i.test(String(name ?? ''));
}

function readFileAsJson(file) {
  return file.text().then((text) => JSON.parse(text));
}

function installDragDrop() {
  let dragDepth = 0;
  const dz = dropZone();

  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth++;
    dz?.classList.add('visible');
  });
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  document.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dz?.classList.remove('visible');
  });
  document.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dz?.classList.remove('visible');
    const file = e.dataTransfer.files[0];
    if (!isStorylineFile(file.name)) return;
    try {
      const archive = await readFileAsJson(file);
      deliverArchive(archive);
    } catch (err) {
      console.error('[main] Failed to parse dropped storyline:', err);
    }
  });
}

function deliverArchive(archive) {
  if (window.__timelensApp?.loadStorylineArchive) {
    window.__timelensApp.loadStorylineArchive(archive);
  } else {
    pendingArchive = archive;
  }
}

function getRelativePath() {
  let p = window.location.pathname;
  if (BASE_URL && p.startsWith(BASE_URL)) {
    p = p.slice(BASE_URL.length) || '/';
  }
  return p;
}

function resolveMode() {
  let relative = getRelativePath();

  if (relative === '/replay') relative = '/replay/';

  if (DEPLOY_TARGET === 'demo' && relative === '/') {
    const target = `${BASE_URL}/replay/${BUNDLED_STORYLINE_NAME}`;
    window.history.replaceState(null, '', target);
    relative = `/replay/${BUNDLED_STORYLINE_NAME}`;
  }

  if (DEPLOY_TARGET === 'dev' && relative === '/') {
    const target = `${BASE_URL}/capture`;
    window.history.replaceState(null, '', target);
    relative = '/capture';
  }

  if (relative.startsWith('/replay/')) {
    return { mode: 'replay', storylinePath: relative.slice('/replay/'.length) };
  }

  return { mode: 'capture' };
}

async function loadStorylineFromUrl(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      console.info(`[main] Storyline not present at ${url} (HTTP ${r.status}); running in live mode.`);
      return;
    }
    const archive = await r.json();
    if (!archive || !Array.isArray(archive.steps)) {
      console.warn(`[main] Storyline at ${url} invalid (missing steps[]); running in live mode.`);
      return;
    }
    console.log(`[main] Loaded storyline from ${url}: ${archive.stepCount} steps, ${archive.requestCount} requests.`);
    deliverArchive(archive);
  } catch (err) {
    console.info(`[main] Failed to load storyline at ${url}; running in live mode.`, err);
  }
}

async function init() {
  const loadingEl = document.getElementById('loading');
  loadingEl.classList.add('visible');

  installDragDrop();

  try {
    const pixiApp = new Application();

    await pixiApp.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x1e1e1e,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    const canvasContainer = document.getElementById('pixi-canvas');
    canvasContainer.appendChild(pixiApp.canvas);

    const app = new App(pixiApp);
    window.__timelensApp = app;

    const resolved = resolveMode();
    if (resolved.mode === 'replay') {
      await loadStorylineFromUrl(`${BASE_URL}/${resolved.storylinePath}`);
    }

    if (pendingArchive) {
      app.loadStorylineArchive(pendingArchive);
      pendingArchive = null;
    }

    await app.initialize();

    if (pendingArchive) {
      app.loadStorylineArchive(pendingArchive);
      pendingArchive = null;
    }

    window.addEventListener('resize', () => {
      pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
      app.handleResize();
    });

    loadingEl.classList.remove('visible');

    console.log(`WinDbg Visualizer initialized in ${resolved.mode} mode`);
  } catch (error) {
    console.error('Failed to initialize application:', error);
    document.getElementById('loading-text').textContent = `Error: ${error.message}`;
  }
}

init();
