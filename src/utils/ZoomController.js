/**
 * ZoomController - Manages multi-level zoom logic
 */
const MIN_ZOOM_LEVEL = 0;
const MAX_ZOOM_LEVEL = 4;

export { MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL };

export default class ZoomController {
  constructor() {
    this.levels = [
      { name: 'Process', scale: 1 / 256, description: 'Entire process memory' },
      { name: 'Region', scale: 1 / 16, description: 'Memory regions (64KB blocks)' },
      { name: 'Page', scale: 1.0, description: 'Memory pages (4KB)' },
      { name: 'Byte', scale: 16, description: 'Individual bytes' },
      { name: 'Bit', scale: 128, description: 'Bit level view' },
    ];

    this.minLevel = 0;
    this.maxLevel = this.levels.length - 1;

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
    if (this.currentLevel < this.maxLevel) {
      this.currentLevel++;
      return true;
    }
    return false;
  }

  zoomOut() {
    if (this.currentLevel > this.minLevel) {
      this.currentLevel--;
      return true;
    }
    return false;
  }

  setLevel(level) {
    if (level >= this.minLevel && level <= this.maxLevel) {
      this.currentLevel = level;
      return true;
    }
    return false;
  }

  reset() {
    this.currentLevel = this.minLevel;
  }
}
