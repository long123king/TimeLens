import { Graphics, Text } from 'pixi.js';

/**
 * MemoryRenderer - Renders memory grid at different zoom levels
 */
export default class MemoryRenderer {
  constructor() {
    this.colors = {
      stack: 0x6a9955,
      heap: 0x4fc3f7,
      code: 0xc586c0,
      data: 0xdcdcaa,
      shared: 0xce9178,
    };
  }

  /**
   * Render memory at page level (4KB pages)
   */
  renderPageLevel(container, regions, focusAddress, width, height, showHeatmap) {
    const pageSize = 4096; // 4KB
    const blockWidth = 20;
    const blockHeight = 20;
    const spacing = 2;
    const cols = Math.floor((width - 100) / (blockWidth + spacing));

    let row = 0;
    let col = 0;

    // Find region containing focus address
    let targetRegion = null;
    for (const region of regions) {
      const start = parseInt(region.start, 16);
      const end = parseInt(region.end, 16);
      if (focusAddress >= start && focusAddress < end) {
        targetRegion = region;
        break;
      }
    }

    if (!targetRegion && regions.length > 0) {
      targetRegion = regions[0];
    }

    if (!targetRegion) return;

    const start = parseInt(targetRegion.start, 16);
    const end = parseInt(targetRegion.end, 16);
    const size = end - start;
    const pageCount = Math.ceil(size / pageSize);

    // Add title
    const title = new Text({
      text: `${targetRegion.type.toUpperCase()} - ${targetRegion.start} to ${targetRegion.end}`,
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 12,
        fill: 0x858585,
      }
    });
    title.x = 10;
    title.y = 10;
    container.addChild(title);

    // Render pages
    for (let i = 0; i < pageCount && row < 30; i++) {
      const pageAddress = start + i * pageSize;

      const block = new Graphics();
      const baseColor = this.colors[targetRegion.type] || 0x808080;
      const color = showHeatmap ? this.getHeatmapColor(Math.random()) : baseColor;

      block.rect(0, 0, blockWidth, blockHeight);
      block.fill(color);
      block.rect(0, 0, blockWidth, blockHeight);
      block.stroke({ width: 1, color: 0x3c3c3c });

      block.x = 50 + col * (blockWidth + spacing);
      block.y = 40 + row * (blockHeight + spacing);

      block.eventMode = 'static';
      block.cursor = 'pointer';

      // Tooltip or click interaction
      block.on('pointerdown', () => {
        console.log('Page clicked:', '0x' + pageAddress.toString(16));
      });

      container.addChild(block);

      col++;
      if (col >= cols) {
        col = 0;
        row++;
      }
    }
  }

  /**
   * Get heatmap color based on access frequency (0-1)
   */
  getHeatmapColor(frequency) {
    if (frequency < 0.2) return 0x1e1e1e; // Cold
    if (frequency < 0.4) return 0x0e4c92; // Cool
    if (frequency < 0.6) return 0x4ec9b0; // Warm
    if (frequency < 0.8) return 0xdcdcaa; // Hot
    return 0xff6b6b; // Very hot
  }

  /**
   * Interpolate between two colors
   */
  interpolateColor(color1, color2, factor) {
    const r1 = (color1 >> 16) & 0xFF;
    const g1 = (color1 >> 8) & 0xFF;
    const b1 = color1 & 0xFF;

    const r2 = (color2 >> 16) & 0xFF;
    const g2 = (color2 >> 8) & 0xFF;
    const b2 = color2 & 0xFF;

    const r = Math.round(r1 + (r2 - r1) * factor);
    const g = Math.round(g1 + (g2 - g1) * factor);
    const b = Math.round(b1 + (b2 - b1) * factor);

    return (r << 16) | (g << 8) | b;
  }
}
