/**
 * ColorSchemes - Color palettes for heatmaps and visualizations
 */
export default class ColorSchemes {
  static heatmap = {
    cold: 0x1e1e1e,
    cool: 0x0e4c92,
    warm: 0x4ec9b0,
    hot: 0xdcdcaa,
    veryHot: 0xff6b6b,
  };

  static regions = {
    stack: 0x6a9955,
    heap: 0x4fc3f7,
    code: 0xc586c0,
    data: 0xdcdcaa,
    shared: 0xce9178,
  };

  static events = {
    memoryRead: 0x4ec9b0,
    memoryWrite: 0xff6b6b,
    functionCall: 0xdcdcaa,
    functionReturn: 0x608b4e,
    registerChange: 0x9cdcfe,
  };

  /**
   * Get heatmap color based on frequency (0-1)
   */
  static getHeatmapColor(frequency) {
    if (frequency < 0.2) return this.heatmap.cold;
    if (frequency < 0.4) return this.heatmap.cool;
    if (frequency < 0.6) return this.heatmap.warm;
    if (frequency < 0.8) return this.heatmap.hot;
    return this.heatmap.veryHot;
  }

  /**
   * Interpolate between two colors
   */
  static interpolate(color1, color2, factor) {
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
