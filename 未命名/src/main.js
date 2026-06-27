import { Application } from 'pixi.js';
import App from './core/App.js';
import './styles/main.css';

// Initialize the application
async function init() {
  const loadingEl = document.getElementById('loading');
  loadingEl.classList.add('visible');

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
    await app.initialize();

    // Handle window resize
    window.addEventListener('resize', () => {
      pixiApp.renderer.resize(window.innerWidth, window.innerHeight);
      app.handleResize();
    });

    loadingEl.classList.remove('visible');

    console.log('WinDbg Visualizer initialized successfully');
  } catch (error) {
    console.error('Failed to initialize application:', error);
    document.getElementById('loading-text').textContent = `Error: ${error.message}`;
  }
}

// Start the application
init();
