import { Container, Graphics, Text } from 'pixi.js';
import MemoryRenderer from '../renderers/MemoryRenderer.js';
import HexRenderer from '../renderers/HexRenderer.js';
import PointerRenderer from '../renderers/PointerRenderer.js';
import { MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL } from '../utils/ZoomController.js';

/**
 * MemoryView - Main memory visualization component
 * Supports multi-level zoom from process level down to bit level
 */
export default class MemoryView {
  constructor(memoryLayer, backgroundLayer, pointersLayer, width, height) {
    this.memoryLayer = memoryLayer;
    this.backgroundLayer = backgroundLayer;
    this.pointersLayer = pointersLayer;
    this.width = width;
    this.height = height;

    // Memory data
    this.memoryData = null;
    this.regions = [];

    // Zoom level (0-4: Process, Region, Page, Byte, Bit)
    this.zoomLevel = MIN_ZOOM_LEVEL;
    this.focusAddress = 0;

    // Renderers for different visualizations
    this.memoryRenderer = new MemoryRenderer();
    this.hexRenderer = new HexRenderer();
    this.pointerRenderer = new PointerRenderer();

    // View toggles
    this.showHeatmap = true;
    this.showRegions = true;
    this.showPointers = true;

    // Event highlights
    this.highlightedEvents = [];

    this.initialize();
  }

  initialize() {
    this.drawBackground();
  }

  drawBackground() {
    // Draw grid background
    const grid = new Graphics();

    // Vertical grid lines
    for (let x = 0; x < this.width; x += 50) {
      grid.moveTo(x, 0);
      grid.lineTo(x, this.height);
      grid.stroke({ width: 1, color: 0x2d2d30, alpha: 0.5 });
    }

    // Horizontal grid lines
    for (let y = 0; y < this.height; y += 50) {
      grid.moveTo(0, y);
      grid.lineTo(this.width, y);
      grid.stroke({ width: 1, color: 0x2d2d30, alpha: 0.5 });
    }

    this.backgroundLayer.addChild(grid);
  }

  setMemoryData(memoryData) {
    this.memoryData = memoryData;

    if (memoryData && memoryData.regions) {
      this.regions = memoryData.regions;
      this.render();
    }
  }

  render() {
    // Clear previous render
    this.memoryLayer.removeChildren();
    this.pointersLayer.removeChildren();

    if (!this.memoryData || !this.regions.length) {
      this.renderEmptyState();
      return;
    }

    // Render based on zoom level
    switch (this.zoomLevel) {
      case 0: // Process level
        this.renderProcessLevel();
        break;
      case 1: // Region level
        this.renderRegionLevel();
        break;
      case 2: // Page level
        this.renderPageLevel();
        break;
      case 3: // Byte level
        this.renderByteLevel();
        break;
      case 4: // Bit level
        this.renderBitLevel();
        break;
    }

    // Render pointers if enabled
    if (this.showPointers) {
      this.renderPointers();
    }

    // Render event highlights
    this.renderEventHighlights();
  }

  renderEmptyState() {
    const text = new Text({
      text: 'No memory data loaded',
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 16,
        fill: 0x858585,
      }
    });
    text.x = this.width / 2 - text.width / 2;
    text.y = this.height / 2 - text.height / 2;
    this.memoryLayer.addChild(text);
  }

  renderProcessLevel() {
    // Draw entire process memory - each region as a colored block
    const totalMemory = this.regions.reduce((sum, r) => {
      return sum + (parseInt(r.end, 16) - parseInt(r.start, 16));
    }, 0);

    let currentY = 50;
    const blockHeight = 40;
    const spacing = 10;

    this.regions.forEach((region, index) => {
      const size = parseInt(region.end, 16) - parseInt(region.start, 16);
      const widthRatio = size / totalMemory;
      const blockWidth = Math.max(50, this.width * widthRatio * 0.8);

      // Region block
      const block = new Graphics();
      const color = this.getRegionColor(region.type);

      block.rect(0, 0, blockWidth, blockHeight);
      block.fill(color);
      block.rect(0, 0, blockWidth, blockHeight);
      block.stroke({ width: 2, color: 0x3c3c3c });

      block.x = (this.width - blockWidth) / 2;
      block.y = currentY;

      block.eventMode = 'static';
      block.cursor = 'pointer';

      block.on('pointerdown', () => {
        this.focusAddress = parseInt(region.start, 16);
        this.zoomLevel = 1;
        this.render();
        if (this.onAddressSelect) {
          this.onAddressSelect(region.start);
        }
      });

      this.memoryLayer.addChild(block);

      // Region label
      const label = new Text({
        text: `${region.type.toUpperCase()}\n${region.start} - ${region.end}\n${this.formatSize(size)}`,
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 10,
          fill: 0xffffff,
          align: 'center',
        }
      });
      label.x = block.x + blockWidth / 2 - label.width / 2;
      label.y = block.y + blockHeight / 2 - label.height / 2;
      this.memoryLayer.addChild(label);

      currentY += blockHeight + spacing;
    });
  }

  renderRegionLevel() {
    // Show memory regions in more detail
    // Each region shown as a grid of blocks (64KB per block)
    const blockSize = 64 * 1024; // 64KB
    const gridCols = 16;
    const blockWidth = 30;
    const blockHeight = 30;
    const spacing = 2;

    let row = 0;
    let col = 0;

    this.regions.forEach(region => {
      const start = parseInt(region.start, 16);
      const end = parseInt(region.end, 16);
      const size = end - start;
      const blockCount = Math.ceil(size / blockSize);

      const color = this.getRegionColor(region.type);

      for (let i = 0; i < blockCount; i++) {
        const block = new Graphics();
        const address = start + i * blockSize;

        // Use heatmap if enabled
        const blockColor = this.showHeatmap ?
          this.getHeatmapColor(address) : color;

        block.rect(0, 0, blockWidth, blockHeight);
        block.fill(blockColor);
        block.rect(0, 0, blockWidth, blockHeight);
        block.stroke({ width: 1, color: 0x3c3c3c });

        block.x = 50 + col * (blockWidth + spacing);
        block.y = 50 + row * (blockHeight + spacing);

        block.eventMode = 'static';
        block.cursor = 'pointer';

        block.on('pointerdown', () => {
          this.focusAddress = address;
          this.zoomLevel = 2;
          this.render();
          if (this.onAddressSelect) {
            this.onAddressSelect('0x' + address.toString(16));
          }
        });

        this.memoryLayer.addChild(block);

        col++;
        if (col >= gridCols) {
          col = 0;
          row++;
        }
      }
    });
  }

  renderPageLevel() {
    // Show memory pages (4KB pages)
    // Similar to region level but finer granularity
    this.memoryRenderer.renderPageLevel(
      this.memoryLayer,
      this.regions,
      this.focusAddress,
      this.width,
      this.height,
      this.showHeatmap
    );
  }

  renderByteLevel() {
    // Show individual bytes as hex grid
    this.hexRenderer.renderByteGrid(
      this.memoryLayer,
      this.memoryData,
      this.focusAddress,
      this.width,
      this.height
    );
  }

  renderBitLevel() {
    // Show individual bits
    this.hexRenderer.renderBitGrid(
      this.memoryLayer,
      this.memoryData,
      this.focusAddress,
      this.width,
      this.height
    );
  }

  renderPointers() {
    // Draw pointer relationships
    this.pointerRenderer.renderPointers(
      this.pointersLayer,
      this.memoryData,
      this.regions,
      this.zoomLevel
    );
  }

  renderEventHighlights() {
    // Highlight memory locations with recent events
    this.highlightedEvents.forEach(event => {
      if (event.address) {
        const address = parseInt(event.address, 16);
        // Draw highlight based on zoom level and event type
        const color = event.type === 'read' ? 0x4ec9b0 : 0xff6b6b;
        this.drawAddressHighlight(address, color);
      }
    });
  }

  drawAddressHighlight(address, color) {
    // Draw a highlight at the given address
    // Implementation depends on current zoom level
    const highlight = new Graphics();
    highlight.circle(100, 100, 10); // Placeholder position
    highlight.fill(color);
    highlight.alpha = 0.6;
    this.memoryLayer.addChild(highlight);
  }

  highlightEvents(events) {
    this.highlightedEvents = events;
    this.render();
  }

  getRegionColor(type) {
    const colors = {
      'stack': 0x6a9955,
      'heap': 0x4fc3f7,
      'code': 0xc586c0,
      'data': 0xdcdcaa,
      'shared': 0xce9178,
    };
    return colors[type] || 0x808080;
  }

  getHeatmapColor(address) {
    // Generate heatmap color based on access frequency
    // This would need actual access data from events
    const frequency = Math.random(); // Placeholder

    if (frequency < 0.2) return 0x1e1e1e; // Cold - dark
    if (frequency < 0.4) return 0x0e4c92; // Cool - blue
    if (frequency < 0.6) return 0x4ec9b0; // Warm - teal
    if (frequency < 0.8) return 0xdcdcaa; // Hot - yellow
    return 0xff6b6b; // Very hot - red
  }

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  toggleHeatmap(enabled) {
    this.showHeatmap = enabled;
    this.render();
  }

  toggleRegions(enabled) {
    this.showRegions = enabled;
    this.render();
  }

  togglePointers(enabled) {
    this.showPointers = enabled;
    this.render();
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.render();
  }

  // Callback when address is selected (set by parent)
  onAddressSelect = null;
}
