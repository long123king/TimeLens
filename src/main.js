import { Application } from 'pixi.js';
import App from './core/App.js';
import './styles/main.css';

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

const BUNDLED_STORYLINE_URL = '/storyline-1783155058679.storyline.json';

async function tryLoadBundledStoryline() {
  try {
    const r = await fetch(BUNDLED_STORYLINE_URL, { cache: 'no-store' });
    if (!r.ok) {
      console.info(`[main] Bundled storyline not present (HTTP ${r.status}); running in live mode.`);
      return;
    }
    const archive = await r.json();
    if (!archive || !Array.isArray(archive.steps)) {
      console.warn('[main] Bundled storyline invalid (missing steps[]); ignoring.');
      return;
    }
    console.log(`[main] Loaded bundled storyline: ${archive.stepCount} steps, ${archive.requestCount} requests.`);
    deliverArchive(archive);
  } catch (err) {
    console.info('[main] No bundled storyline available; running in live mode.', err);
  }
}

// Initialize the application
async function init() {
  const loadingEl = document.getElementById('loading');
  loadingEl.classList.add('visible');

  installDragDrop();

  try {
    // Create PixiJS application
    const pixiApp = new Application();

    await pixiApp.init({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundColor: 0x1e1e1e,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

    // Add canvas to DOM
    const canvasContainer = document.getElementById('pixi-canvas');
    canvasContainer.appendChild(pixiApp.canvas);

    // Create main app controller
    const app = new App(pixiApp);
    window.__timelensApp = app;
    if (pendingArchive) {
      app.loadStorylineArchive(pendingArchive);
      pendingArchive = null;
    }
    await app.initialize();
    if (pendingArchive) {
      app.loadStorylineArchive(pendingArchive);
      pendingArchive = null;
    }

    // Handle window resize
    window.addEventListener('resize', () => {
      pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
      app.handleResize();
    });

    loadingEl.classList.remove('visible');

    // Auto-enter replay mode if a storyline is bundled with the deployment
    // (e.g. /storyline-1783155058679.storyline.json under public/). When the
    // file is absent (local dev against a real dk server) this is a no-op.
    tryLoadBundledStoryline();

    console.log('WinDbg Visualizer initialized successfully');
  } catch (error) {
    console.error('Failed to initialize application:', error);
    document.getElementById('loading-text').textContent = `Error: ${error.message}`;
  }
}

// Start the application
init();
