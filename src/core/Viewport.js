import { Container, Graphics, Text } from 'pixi.js';

/**
 * Viewport - Manages PixiJS containers and camera transformations
 * Handles pan, zoom, and coordinate transformations
 */
export default class Viewport {
  constructor(app) {
    this.app = app;
    this.width = app.screen.width;
    this.height = app.screen.height;

    // Layout reservation for non-canvas panels
    this.layout = {
      margin: 10,
      // Right dock is sized from a golden-ratio split and synced to CSS.
      rightDockWidth: 440,
    };

    this.updateRightDockWidth();

    // Create layered containers
    this.setupContainers();

    // Camera state
    this.camera = {
      x: 0,
      y: 0,
      zoom: 1,
      targetZoom: 1,
    };

    // Pan state
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };
    this.lastPanPosition = { x: 0, y: 0 };

    // Setup interactions
    this.setupInteractions();
  }

  setupContainers() {
    // Main container for all visualization layers
    this.root = new Container();
    this.root.x = this.layout.margin;
    this.root.y = this.layout.margin;
    this.app.stage.addChild(this.root);

    // Background layer (grid, guides)
    this.backgroundLayer = new Container();
    this.backgroundLayer.label = 'Background';
    this.root.addChild(this.backgroundLayer);

    // Memory visualization layer
    this.memoryLayer = new Container();
    this.memoryLayer.label = 'Memory';
    this.root.addChild(this.memoryLayer);

    // Pointers layer
    this.pointersLayer = new Container();
    this.pointersLayer.label = 'Pointers';
    this.root.addChild(this.pointersLayer);

    // Timeline layer (fixed at bottom)
    this.timelineLayer = new Container();
    this.timelineLayer.label = 'Timeline';
    this.timelineLayer.x = this.layout.margin;
    this.timelineLayer.y = this.timelineY;
    this.app.stage.addChild(this.timelineLayer);

    // UI layer (debug info, overlays)
    this.uiLayer = new Container();
    this.uiLayer.label = 'UI';
    this.app.stage.addChild(this.uiLayer);
  }

  setupInteractions() {
    const canvas = this.app.canvas;

    // Mouse wheel for zoom
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoom(delta, e.clientX, e.clientY);
    });

    // Mouse drag for pan
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
        // Right click or Ctrl+Left click for pan
        this.startPan(e.clientX, e.clientY);
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.isPanning) {
        this.updatePan(e.clientX, e.clientY);
      }
    });

    canvas.addEventListener('mouseup', () => {
      this.endPan();
    });

    canvas.addEventListener('mouseleave', () => {
      this.endPan();
    });

    // Disable context menu
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  startPan(x, y) {
    this.isPanning = true;
    this.panStart = { x, y };
    this.lastPanPosition = { x: this.camera.x, y: this.camera.y };
    this.app.canvas.style.cursor = 'grabbing';
  }

  updatePan(x, y) {
    if (!this.isPanning) return;

    const dx = x - this.panStart.x;
    const dy = y - this.panStart.y;

    this.camera.x = this.lastPanPosition.x + dx;
    this.camera.y = this.lastPanPosition.y + dy;

    this.applyTransform();
  }

  endPan() {
    this.isPanning = false;
    this.app.canvas.style.cursor = 'default';
  }

  zoom(delta, mouseX, mouseY) {
    const oldZoom = this.camera.zoom;
    this.camera.zoom = Math.max(0.1, Math.min(1000, this.camera.zoom * delta));

    // Zoom toward mouse position
    if (mouseX !== undefined && mouseY !== undefined) {
      const zoomRatio = this.camera.zoom / oldZoom;
      this.camera.x = mouseX - (mouseX - this.camera.x) * zoomRatio;
      this.camera.y = mouseY - (mouseY - this.camera.y) * zoomRatio;
    }

    this.applyTransform();
  }

  setZoom(zoom, centerX, centerY) {
    const oldZoom = this.camera.zoom;
    this.camera.zoom = Math.max(0.1, Math.min(1000, zoom));

    if (centerX !== undefined && centerY !== undefined) {
      const zoomRatio = this.camera.zoom / oldZoom;
      this.camera.x = centerX - (centerX - this.camera.x) * zoomRatio;
      this.camera.y = centerY - (centerY - this.camera.y) * zoomRatio;
    }

    this.applyTransform();
  }

  resetCamera() {
    this.camera.x = 0;
    this.camera.y = 0;
    this.camera.zoom = 1;
    this.applyTransform();
  }

  applyTransform() {
    // Apply camera transform to main visualization layers
    this.root.position.set(this.camera.x, this.camera.y);
    this.root.scale.set(this.camera.zoom);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.updateRightDockWidth();

    // Update fixed layer positions
    this.root.x = this.layout.margin;
    this.root.y = this.layout.margin;
    this.timelineLayer.x = this.layout.margin;
    this.timelineLayer.y = this.timelineY;
  }

  updateRightDockWidth() {
    const usableWidth = Math.max(0, this.width - this.layout.margin * 2);
    const goldenDockWidth = Math.round(usableWidth * (1 - 0.618));
    const dockWidth = Math.max(380, Math.min(560, goldenDockWidth));

    // Reserve a little extra space so plot labels do not collide with the dock.
    this.layout.rightDockWidth = dockWidth + 20;

    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--right-dock-width', `${dockWidth}px`);
    }
  }

  get visualizationWidth() {
    const raw = this.width - this.layout.rightDockWidth - this.layout.margin * 2;
    return Math.max(480, raw);
  }

  get visualizationHeight() {
    return 0;
  }

  get timelineHeight() {
    return this.height - this.layout.margin * 2;
  }

  get timelineY() {
    return this.layout.margin;
  }

  screenToWorld(screenX, screenY) {
    return {
      x: (screenX - this.camera.x) / this.camera.zoom,
      y: (screenY - this.camera.y) / this.camera.zoom,
    };
  }

  worldToScreen(worldX, worldY) {
    return {
      x: worldX * this.camera.zoom + this.camera.x,
      y: worldY * this.camera.zoom + this.camera.y,
    };
  }
}
