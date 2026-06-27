import { Graphics } from 'pixi.js';

/**
 * PointerRenderer - Renders pointer relationships between memory locations
 */
export default class PointerRenderer {
  constructor() {
    this.pointers = [];
  }

  /**
   * Render pointer arrows between memory locations
   */
  renderPointers(container, memoryData, regions, zoomLevel) {
    container.removeChildren();

    if (!memoryData || !memoryData.data) {
      return;
    }

    // Decode memory data and find pointers
    const binaryString = atob(memoryData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Find potential pointers (8-byte aligned values that look like addresses)
    const pointers = this.findPointers(bytes, regions);

    // Render subset of pointers (to avoid clutter)
    const maxPointers = 20;
    const visiblePointers = pointers.slice(0, maxPointers);

    visiblePointers.forEach(pointer => {
      this.drawPointerArrow(
        container,
        pointer.fromAddress,
        pointer.toAddress,
        pointer.fromX,
        pointer.fromY,
        pointer.toX,
        pointer.toY
      );
    });
  }

  /**
   * Find potential pointers in memory data
   */
  findPointers(bytes, regions) {
    const pointers = [];
    const pointerSize = 8; // 64-bit pointers

    // Mock pointer detection (in reality, would need proper address analysis)
    for (let i = 0; i < Math.min(bytes.length - pointerSize, 100); i += pointerSize) {
      // Read 8-byte value as potential pointer
      let value = 0;
      for (let j = 0; j < pointerSize; j++) {
        value |= bytes[i + j] << (j * 8);
      }

      // Check if value looks like a valid address
      if (value > 0x1000 && value < 0xFFFFFFFFFFFF) {
        // Check if points to a valid region
        const pointsToValid = regions.some(r => {
          const start = parseInt(r.start, 16);
          const end = parseInt(r.end, 16);
          return value >= start && value < end;
        });

        if (pointsToValid || Math.random() > 0.9) {
          pointers.push({
            fromAddress: i,
            toAddress: value,
            fromX: (i % 16) * 30 + 100,
            fromY: Math.floor(i / 16) * 30 + 100,
            toX: (value % 16) * 30 + 100,
            toY: Math.floor(value / 16) * 30 + 200,
          });
        }
      }
    }

    return pointers;
  }

  /**
   * Draw a curved arrow from one point to another
   */
  drawPointerArrow(container, fromAddress, toAddress, fromX, fromY, toX, toY) {
    const arrow = new Graphics();

    // Calculate control point for curve
    const midX = (fromX + toX) / 2;
    const midY = (fromY + toY) / 2;
    const controlX = midX + (toY - fromY) * 0.2;
    const controlY = midY - (toX - fromX) * 0.2;

    // Draw curved line
    arrow.moveTo(fromX, fromY);
    arrow.bezierCurveTo(
      controlX, controlY,
      controlX, controlY,
      toX, toY
    );
    arrow.stroke({ width: 1.5, color: 0x9cdcfe, alpha: 0.6 });

    // Draw arrowhead
    const angle = Math.atan2(toY - controlY, toX - controlX);
    const arrowSize = 8;

    arrow.moveTo(toX, toY);
    arrow.lineTo(
      toX - arrowSize * Math.cos(angle - Math.PI / 6),
      toY - arrowSize * Math.sin(angle - Math.PI / 6)
    );
    arrow.moveTo(toX, toY);
    arrow.lineTo(
      toX - arrowSize * Math.cos(angle + Math.PI / 6),
      toY - arrowSize * Math.sin(angle + Math.PI / 6)
    );
    arrow.stroke({ width: 1.5, color: 0x9cdcfe, alpha: 0.8 });

    // Make interactive
    arrow.eventMode = 'static';
    arrow.cursor = 'pointer';
    arrow.hitArea = this.createHitArea(fromX, fromY, toX, toY, controlX, controlY);

    arrow.on('pointerover', () => {
      arrow.alpha = 1;
    });

    arrow.on('pointerout', () => {
      arrow.alpha = 0.6;
    });

    arrow.on('pointerdown', () => {
      console.log(`Pointer: 0x${fromAddress.toString(16)} -> 0x${toAddress.toString(16)}`);
    });

    container.addChild(arrow);
  }

  /**
   * Create hit area for curve
   */
  createHitArea(fromX, fromY, toX, toY, controlX, controlY) {
    // Simple rectangular hit area around the curve
    const minX = Math.min(fromX, toX, controlX) - 5;
    const maxX = Math.max(fromX, toX, controlX) + 5;
    const minY = Math.min(fromY, toY, controlY) - 5;
    const maxY = Math.max(fromY, toY, controlY) + 5;

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      contains: function(x, y) {
        return x >= this.x && x <= this.x + this.width &&
               y >= this.y && y <= this.y + this.height;
      }
    };
  }

  /**
   * Draw pointer as a simple line (for lower zoom levels)
   */
  drawSimplePointer(container, fromX, fromY, toX, toY) {
    const line = new Graphics();

    line.moveTo(fromX, fromY);
    line.lineTo(toX, toY);
    line.stroke({ width: 1, color: 0x9cdcfe, alpha: 0.4 });

    container.addChild(line);
  }
}
