/**
 * ZoomController - Manages multi-level zoom logic
 */
export default class ZoomController {
  constructor() {
    this.levels = [
      { name: 'Process', scale: 1, description: 'Entire process memory' },
      { name: 'Region', scale: 16, description: 'Memory regions (64KB blocks)' },
      { name: 'Page', scale: 256, description: 'Memory pages (4KB)' },
      { name: 'Byte', scale: 4096, description: 'Individual bytes' },
      { name: 'Bit', scale: 32768, description: 'Bit level view' },
    ];

    this.currentLevel = 0;
  }

  getLevel() {
    return this.currentLevel;
  }

  getLevelName() {
    return this.levels[this.currentLevel].name;
  }

  getLevelScale() {
    return this.levels[this.currentLevel].scale;
  }

  zoomIn() {
    if (this.currentLevel < this.levels.length - 1) {
      this.currentLevel++;
      return true;
    }
    return false;
  }

  zoomOut() {
    if (this.currentLevel > 0) {
      this.currentLevel--;
      return true;
    }
    return false;
  }

  setLevel(level) {
    if (level >= 0 && level < this.levels.length) {
      this.currentLevel = level;
      return true;
    }
    return false;
  }

  reset() {
    this.currentLevel = 0;
  }
}
