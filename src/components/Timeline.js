import { Graphics, Container, Text } from 'pixi.js';

// Lane layout constants
const LABEL_W       = 140; // left-side label column width
const AXIS_AREA     = 28;  // bottom x-axis area height
const MINIMAP_H     = 18;  // minimap strip height
const MINIMAP_PAD   = 6;   // gap below minimap
const TOP_PAD       = 4;   // gap above first lane
const LANE_H_FULL   = 28;  // expanded lane height
const LANE_H_THIN   = 10;  // collapsed (thin) lane height
const LANE_GAP      = 2;   // vertical gap between lanes
const RIBBON_PAD    = 2;   // vertical padding inside lane for ribbon
const SECTION_GAP   = 10;  // gap between module and thread sections

// Colour palette for module lanes (cycles for >8 modules)
const LANE_COLORS = [
  0x4ec9b0, 0xdcdcaa, 0x9cdcfe, 0xce9178, 0xc586c0,
  0x4fc1ff, 0xb5cea8, 0xf44747,
];

// Distinct colour palette for thread lanes
const THREAD_LANE_COLORS = [
  0xff6b6b, 0xffa94d, 0xa8e6cf, 0xffd3b6, 0xffaaa5,
  0xff8b94, 0xf8b500, 0x00d9ff, 0xc1b2f0, 0xa4de6c,
];

// 1 major == MINOR_PER_MAJOR minor steps.  Minor resets at each major boundary.
const MINOR_PER_MAJOR = 100000n;

/**
 * Timeline - TTD timeline visualization.
 *
 * Phase 1: x-axis with major-position ticks, scrubber, minimap.
 * Phase 2: dynamic per-module lane grid with lifespan bars, expand/collapse
 *          skeleton, main module pinned at the bottom lane.
 */
export default class Timeline {
  constructor(container, width, height) {
    this.container = container;
    this.width = width;
    this.height = height;

    this.timeRange = { start: 0, end: 10000 };
    this.currentTime = 0;
    this.events = [];
    this.majorRange = null; // { start: bigint, end: bigint, startMinor?, endMinor? }

    // Phase 2: module lane state
    this._modules = [];          // sorted by laneOrderHint (main last)
    this._laneExpanded = {};     // moduleId -> boolean (skeleton; all collapsed by default)
    this._pinned = {};           // moduleId -> boolean (pinned modules sink to bottom)
    this._moduleColorById = {};  // moduleId -> lane color (stable across pin/unpin)
    this._moduleLaneCenterByKey = new Map(); // normalized module key -> { y, color }
    this._nextModuleColorIndex = 0;
    this._hoveredModuleId = null; // moduleId currently being hovered
    this._unpinnedLaneFitHeight = LANE_H_THIN; // computed per render to fit all unpinned lanes

    // Shared x-axis view window over current domain (0..1 normalized)
    this._xViewStartNorm = 0;
    this._xViewEndNorm = 1;
    // Allow deep zoom for fine-grained inspection.
    this._xZoomMinSpan = 0.000001;

    // Shift+drag range zoom interaction state.
    this._isRangeZoomDragging = false;
    this._rangeZoomStartGlobalX = 0;
    this._rangeZoomCurrentGlobalX = 0;
    this._rangeZoomOverlay = null;
    this._rangeAnchorHintTimer = null;

    // Persistent zoom-limit state (true when current view is at minimum span).
    this._zoomLimitReached = false;

    this._threads = [];           // sorted by threadId ascending
    this._threadExpanded = {};    // threadId -> boolean
    this._hoveredThreadId = null; // threadId currently being hovered
    this._activeThreadId = null;  // single selected thread id
    this._hoveredSyncedEvent = null; // synced function-call event currently hovered
    this._syncedMarkers = [];        // { gfx, event, x, laneY, laneColor } for each rendered circle

    // Plot geometry
    this.leftPad   = 10;
    this.rightPad  = 10;
    this.labelWidth = 150;

    // Visual element containers
    this.background    = null;
    this.lanesLayer    = new Container();   // Phase 2 module lanes
    this.tracksContainer = new Container(); // kept for future event tracks (Phase 4+)
    this.axisLayer     = new Container();
    this.scrubber      = null;
    this.scrubberLabel = null;
    this.minimap       = null;

    // Interaction state
    this.isDraggingScrubber  = false;
    this.isScrubberHovered   = false;
    this._isActive = true;

    // Tooltip div for hover info
    this.tooltipDiv = null;
    this.axisHintDiv = null;
    this._isAxisHovering = false;

    // Keyboard interaction (bound once, reused across resizes)
    this._spaceHotkeyBound = false;
    this._onWindowKeyDown = (e) => this._handleWindowKeyDown(e);

    this.initialize();
  }

  // ---------------------------------------------------------------------------
  // Layout helpers
  // ---------------------------------------------------------------------------

  /** Left x of the plot area (after the label column). */
  getPlotX() { return this.leftPad + LABEL_W; }

  /** Width of the plot area. */
  getPlotWidth() {
    return Math.max(200, this.width - this.leftPad - LABEL_W - this.rightPad);
  }

  /** Y where lanes start (below minimap). */
  get _lanesTop() { return MINIMAP_H + MINIMAP_PAD + TOP_PAD; }

  /** Y of the x-axis line (near bottom edge). */
  get _axisY() { return this.height - AXIS_AREA + 10; }

  get _moduleSectionTop() { return this._lanesTop; }
  get _moduleSectionBottom() {
    const avail = Math.max(20, this._axisY - this._lanesTop - SECTION_GAP);
    return this._lanesTop + Math.floor(avail / 2);
  }
  get _threadSectionTop() { return this._moduleSectionBottom + SECTION_GAP; }
  get _threadSectionBottom() { return this._axisY; }

  /** Height of a lane for the given module object. */
  _laneHeight(mod) {
    // Pinned and main modules are always shown at full height
    if (mod.isMain === true || this._pinned[mod.moduleId]) return LANE_H_FULL;
    const isExpanded = this._laneExpanded[mod.moduleId] ?? false;
    const isHovered = this._hoveredModuleId === mod.moduleId;
    return (isExpanded || isHovered) ? LANE_H_FULL : LANE_H_THIN;
  }

  /** Top Y of lane at sorted index `i`. */
  _laneY(index) {
    let y = this._moduleSectionTop;
    for (let i = 0; i < index; i++) {
      y += this._laneHeight(this._modules[i]) + LANE_GAP;
    }
    return y;
  }

  _threadLaneHeight(thread) {
    void thread;
    return LANE_H_FULL;
  }

  _threadLaneY(index) {
    let y = this._threadSectionTop;
    for (let i = 0; i < index; i++) {
      y += this._threadLaneHeight(this._threads[i]) + LANE_GAP;
    }
    return y;
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  initialize() {
    // Create tooltip div for module hover info
    if (!this.tooltipDiv) {
      this.tooltipDiv = document.createElement('div');
      this.tooltipDiv.style.cssText = `
        position: fixed;
        background: rgba(30, 30, 30, 0.95);
        border: 1px solid #3c3c3c;
        border-radius: 4px;
        padding: 8px 10px;
        font-size: 11px;
        font-family: 'Consolas', monospace;
        color: #d4d4d4;
        pointer-events: none;
        display: none;
        z-index: 10000;
        max-width: 300px;
        white-space: pre;
      `;
      document.body.appendChild(this.tooltipDiv);
    }

    if (!this.axisHintDiv) {
      this.axisHintDiv = document.createElement('div');
      this.axisHintDiv.style.cssText = `
        position: fixed;
        background: rgba(28, 28, 22, 0.96);
        border: 1px solid #ffd54f;
        border-radius: 4px;
        padding: 6px 8px;
        font-size: 11px;
        font-family: 'Consolas', monospace;
        color: #ffd54f;
        pointer-events: none;
        display: none;
        z-index: 10001;
        white-space: pre-line;
      `;
      this.axisHintDiv.textContent = 'Pos: 0:0\nWheel: Zoom X  |  Shift+Wheel: Pan X  |  Shift+Drag: Zoom Range  |  R: Reset';
      document.body.appendChild(this.axisHintDiv);
    }

    this.drawBackground();
    this.container.addChild(this.lanesLayer);
    this.container.addChild(this.tracksContainer);
    this.createMinimap();
    this.createScrubber();
    this.createRangeZoomOverlay();
    this.container.addChild(this.axisLayer);
    this.renderXAxis();
    this._renderLanes();
    this.setupInteractions();
  }

  drawBackground() {
    this.background = new Graphics();
    this.background.rect(0, 0, this.width, this.height);
    this.background.fill(0x252526);
    this.background.rect(0, 0, this.width, this.height);
    this.background.stroke({ width: 1, color: 0x3c3c3c });
    this.container.addChild(this.background);
  }

  // ---------------------------------------------------------------------------
  // Phase 2 - Module lane rendering
  // ---------------------------------------------------------------------------

  /**
   * Set module list from /api/ttd/modules response.
   * Non-main modules are sorted by laneOrderHint ascending; main module and 
   * pinned modules are always placed last so they render at the bottom.
   */
  setModules(modules) {
    this._hideTooltip();
    const hasNew = modules.some(m => !(m.moduleId in this._laneExpanded));

    // Assign stable colors once per module so pin/unpin reorder does not change color.
    modules.forEach((m) => {
      const key = String(m.moduleId ?? m.name ?? m.path ?? '');
      if (!key) return;
      if (!(key in this._moduleColorById)) {
        const color = LANE_COLORS[this._nextModuleColorIndex % LANE_COLORS.length];
        this._moduleColorById[key] = color;
        this._nextModuleColorIndex += 1;
      }
    });

    this._modules = [...modules].sort((a, b) => {
      const aMain = a.isMain === true ? 1 : 0;
      const bMain = b.isMain === true ? 1 : 0;
      const aPinned = this._pinned[a.moduleId] ? 1 : 0;
      const bPinned = this._pinned[b.moduleId] ? 1 : 0;

      // Keep pinned modules and main module in a stable bottom group.
      const aBottom = (aPinned || aMain) ? 1 : 0;
      const bBottom = (bPinned || bMain) ? 1 : 0;
      if (aBottom !== bBottom) return aBottom - bBottom;

      // In bottom group, keep main module at the very bottom.
      if (aBottom === 1 && aMain !== bMain) return aMain - bMain;

      // Otherwise preserve backend order hint.
      return (a.laneOrderHint ?? 0) - (b.laneOrderHint ?? 0);
    });
    if (hasNew) {
      this._laneExpanded = {};
      this._applyInitialExpandState();
    }
    this._renderLanes();
    this._bringOverlaysToFront();
  }

  setThreads(threads) {
    this._hideTooltip();
    const hasNew = threads.some(t => !(t.threadId in this._threadExpanded));
    this._threads = [...threads].sort((a, b) => (a.threadId ?? 0) - (b.threadId ?? 0));

    // Keep exactly one active thread when thread data exists.
    if (this._threads.length === 0) {
      this._activeThreadId = null;
    } else if (!this._threads.some(t => t.threadId === this._activeThreadId)) {
      this._activeThreadId = this._threads[0].threadId;
      this.onThreadSelect?.(this._activeThreadId);
    }

    if (hasNew) {
      this._threadExpanded = {};
      this._applyInitialThreadExpandState();
    }
    this._renderLanes();
    this._bringOverlaysToFront();
  }

  setActiveThreadId(threadId, { notify = false } = {}) {
    const exists = this._threads.some(t => t.threadId === threadId);
    if (!exists) return false;
    if (this._activeThreadId === threadId) {
      if (notify) this.onThreadSelect?.(threadId);
      return true;
    }
    this._activeThreadId = threadId;

    // Preserve current scrubber position while refreshing active-lane visuals.
    this.setTime(this.currentTime);
    this._renderLanes();
    this._bringOverlaysToFront();
    if (notify) this.onThreadSelect?.(threadId);
    return true;
  }

  _applyInitialExpandState() {
    const n = this._modules.length;
    if (n === 0) return;
    const availH   = this._moduleSectionBottom - this._moduleSectionTop;
    const allFullH = n * LANE_H_FULL + (n - 1) * LANE_GAP;
    if (allFullH <= availH) {
      // All fit when expanded
      this._modules.forEach(m => { this._laneExpanded[m.moduleId] = true; });
    } else {
      // Main module expanded, others collapsed
      this._modules.forEach(m => {
        this._laneExpanded[m.moduleId] = m.isMain === true;
      });
    }
  }

  _applyInitialThreadExpandState() {
    const n = this._threads.length;
    if (n === 0) return;
    const availH   = this._threadSectionBottom - this._threadSectionTop;
    const allFullH = n * LANE_H_FULL + (n - 1) * LANE_GAP;
    if (allFullH <= availH) {
      this._threads.forEach(t => { this._threadExpanded[t.threadId] = true; });
    } else {
      this._threads.forEach(t => { this._threadExpanded[t.threadId] = false; });
    }
  }

  _renderLanes() {
    this.lanesLayer.removeChildren();
    this._moduleLaneCenterByKey.clear();
    const hasModules = this._modules.length > 0;
    const hasThreads = this._threads.length > 0;
    if (!hasModules && !hasThreads) return;

    const plotX     = this.getPlotX();
    const plotWidth = this.getPlotWidth();

    // Section divider
    if (hasModules && hasThreads) {
      const divY = this._moduleSectionBottom + Math.floor(SECTION_GAP / 2);
      const div = new Graphics();
      div.moveTo(0, divY);
      div.lineTo(this.width, divY);
      div.stroke({ width: 2, color: 0x3a4a54 });
      this.lanesLayer.addChild(div);

      const threadHeader = new Text({
        text: '⧗ Threads',
        style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 11, fill: 0x7fc0f0, fontWeight: 'bold' },
      });
      threadHeader.x = this.leftPad;
      threadHeader.y = this._threadSectionTop - 14;
      this.lanesLayer.addChild(threadHeader);

      // Underline for thread header
      const underline = new Graphics();
      underline.moveTo(this.leftPad, this._threadSectionTop - 8);
      underline.lineTo(this.leftPad + threadHeader.width + 20, this._threadSectionTop - 8);
      underline.stroke({ width: 1, color: 0x4a7a9a });
      this.lanesLayer.addChild(underline);
    }

    // --- Module lanes: split into unpinned (scrollable) above and pinned+main anchored at bottom ---
    const moduleColorMap = new Map(
      this._modules.map((m) => {
        const key = String(m.moduleId ?? m.name ?? m.path ?? '');
        const fallback = LANE_COLORS[0];
        return [m.moduleId, this._moduleColorById[key] ?? fallback];
      }),
    );
    const unpinnedMods = this._modules.filter(m => !this._pinned[m.moduleId] && m.isMain !== true);
    const pinnedMods   = this._modules.filter(m =>  this._pinned[m.moduleId] || m.isMain === true);

    // Pinned zone height anchored to _moduleSectionBottom
    const pinnedTotalH = pinnedMods.length === 0 ? 0 :
      pinnedMods.reduce((acc, m) => acc + this._laneHeight(m) + LANE_GAP, 0) - LANE_GAP;
    const pinnedSep = (pinnedMods.length > 0 && unpinnedMods.length > 0) ? LANE_GAP * 4 : 0;
    const scrollZoneTop    = this._moduleSectionTop;
    const scrollZoneBottom = this._moduleSectionBottom - pinnedTotalH - pinnedSep;
    const scrollZoneH      = Math.max(0, scrollZoneBottom - scrollZoneTop);

    // Fit all unpinned modules into the available space - no vertical scrolling.
    // Hovered unpinned lane is expanded to main-lane height; others compress to fit.
    const unpinnedLaneHeights = new Map();
    if (unpinnedMods.length > 0 && scrollZoneH > 0) {
      const n = unpinnedMods.length;
      const gapsH = (n - 1) * LANE_GAP;
      const lanesH = Math.max(0, scrollZoneH - gapsH);
      const hoveredIdx = unpinnedMods.findIndex(m => m.moduleId === this._hoveredModuleId);

      if (hoveredIdx >= 0) {
        const hoveredH = Math.min(LANE_H_FULL, lanesH);
        const restCount = n - 1;
        const restH = Math.max(0, lanesH - hoveredH);
        const restBase = restCount > 0 ? Math.floor(restH / restCount) : 0;
        let restExtra = restCount > 0 ? (restH - (restBase * restCount)) : 0;

        unpinnedMods.forEach((mod, i) => {
          if (i === hoveredIdx) {
            unpinnedLaneHeights.set(mod.moduleId, hoveredH);
          } else {
            const h = restBase + (restExtra > 0 ? 1 : 0);
            if (restExtra > 0) restExtra -= 1;
            unpinnedLaneHeights.set(mod.moduleId, h);
          }
        });
      } else {
        const base = Math.floor(lanesH / n);
        let extra = lanesH - (base * n);
        unpinnedMods.forEach((mod) => {
          const h = base + (extra > 0 ? 1 : 0);
          if (extra > 0) extra -= 1;
          unpinnedLaneHeights.set(mod.moduleId, h);
        });
      }
    }

    // Shared renderer for a single module lane into any target Container
    const renderModLane = (mod, laneY, target, inPinnedZone) => {
      const laneH    = inPinnedZone ? this._laneHeight(mod) : (unpinnedLaneHeights.get(mod.moduleId) ?? LANE_H_THIN);
      const isMain   = mod.isMain === true;
      const isPinned = this._pinned[mod.moduleId] === true;
      const expandedByState = this._laneExpanded[mod.moduleId] ?? false;
      const expandedByHover = !inPinnedZone && this._hoveredModuleId === mod.moduleId;
      const expanded = expandedByState || expandedByHover;
      const color    = moduleColorMap.get(mod.moduleId);

      const bg = new Graphics();
      bg.rect(0, laneY, this.width, laneH);
      bg.fill(isMain ? 0x192820 : (inPinnedZone ? (expanded ? 0x1e1e2a : 0x1a1a26) : (expanded ? 0x222222 : 0x1c1c1c)));
      bg.rect(0, laneY, this.width, laneH);
      bg.stroke({ width: 1, color: isMain ? 0x2a4a3a : (inPinnedZone ? 0x2a2a42 : 0x262626) });
      bg.eventMode = 'static';
      bg.cursor = 'pointer';

      // Click: pin unpinned module, unpin pinned module (main is fixed)
      bg.on('pointerdown', (evt) => {
        if (evt.shiftKey) {
          evt.stopPropagation();
          this._startRangeZoomDrag(evt.global.x);
          return;
        }
        evt.stopPropagation();
        if (isMain) return;
        this._pinned[mod.moduleId] = !isPinned;
        this.setModules(this._modules);
      });

      bg.on('pointermove', (evt) => {
        if (this._hoveredModuleId !== mod.moduleId) {
          this._hoveredModuleId = mod.moduleId;
          this._renderLanes();
          this._bringOverlaysToFront();
        }
        this._showTooltip(mod, evt.global.x, evt.global.y);
      });

      bg.on('pointerout', () => {
        this._hoveredModuleId = null;
        this._hideTooltip();
        this._renderLanes();
        this._bringOverlaysToFront();
      });

      target.addChild(bg);

      this._indexModuleLane(mod, laneY, laneH, color);

      // Lifetime ribbons
      const ribbonH = Math.max(3, laneH - 2 * RIBBON_PAD);
      const ribbonY = laneY + RIBBON_PAD;
      const lifetimes = mod.lifetimes?.length > 0
        ? mod.lifetimes
        : (mod.loadPosition ? [{ loadPosition: mod.loadPosition, unloadPosition: mod.unloadPosition }] : []);
      lifetimes.forEach(lt => {
        const ribbon = this._buildRibbon(lt.loadPosition, lt.unloadPosition, ribbonY, ribbonH, plotWidth, color);
        if (ribbon) target.addChild(ribbon);
      });

      // Label
      const labelText = mod.name ?? mod.path ?? mod.moduleId ?? '?';
      const fontSize  = expanded ? 11 : 10;
      const label = new Text({
        text: labelText,
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize,
          fill: isMain ? 0x5de0c8 : (inPinnedZone ? (expanded ? 0xc8c8d8 : 0xaaaacc) : (expanded ? 0xc8c8d8 : 0xa0a0bc)),
        },
      });
      label.x = Math.max(this.leftPad, plotX - 8 - label.width);
      label.y = laneY + (laneH - label.height) / 2;
      target.addChild(label);

      // Badges
      if (isMain && expanded) {
        const badge = new Text({ text: '[M]', style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 9, fill: 0x4ec9b0 } });
        badge.x = this.leftPad;
        badge.y = laneY + (laneH - badge.height) / 2;
        target.addChild(badge);
      } else if (isPinned && !isMain && expanded) {
        const badge = new Text({ text: '[P]', style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 9, fill: 0xaaaadd } });
        badge.x = this.leftPad;
        badge.y = laneY + (laneH - badge.height) / 2;
        target.addChild(badge);
      }

      // Collapse arrow
      if (expanded) {
        const arrow = new Text({ text: 'v', style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 8, fill: 0x666677 } });
        arrow.x = plotX - arrow.width - 2;
        arrow.y = laneY + (laneH - arrow.height) / 2;
        target.addChild(arrow);
      }
    };

    // --- Unpinned fit-to-window zone (no vertical scroll) ---
    if (unpinnedMods.length > 0 && scrollZoneH > 0) {
      let curY = scrollZoneTop;
      unpinnedMods.forEach((mod, i) => {
        const laneH = unpinnedLaneHeights.get(mod.moduleId) ?? LANE_H_THIN;
        renderModLane(mod, curY, this.lanesLayer, false);
        if (i < unpinnedMods.length - 1) {
          const sep = new Graphics();
          sep.moveTo(0, curY + laneH);
          sep.lineTo(this.width, curY + laneH);
          sep.stroke({ width: 1, color: 0x282828 });
          this.lanesLayer.addChild(sep);
        }
        curY += laneH + LANE_GAP;
      });
    }

    // --- Pinned zone separator ---
    if (pinnedMods.length > 0 && unpinnedMods.length > 0) {
      const sepY = scrollZoneBottom + Math.floor(pinnedSep / 2);
      const sep = new Graphics();
      sep.moveTo(this.leftPad + 8, sepY);
      sep.lineTo(this.width, sepY);
      sep.stroke({ width: 1, color: 0x38384a });
      this.lanesLayer.addChild(sep);
      const sepLabel = new Text({
        text: '── pinned',
        style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 9, fill: 0x7070a0 },
      });
      sepLabel.x = this.leftPad;
      sepLabel.y = sepY - sepLabel.height / 2;
      this.lanesLayer.addChild(sepLabel);
    }

    // --- Pinned+main lanes anchored to bottom of module section ---
    if (pinnedMods.length > 0) {
      let pinnedY = this._moduleSectionBottom;
      for (let i = pinnedMods.length - 1; i >= 0; i--) {
        const mod   = pinnedMods[i];
        const laneH = this._laneHeight(mod);
        pinnedY -= laneH;
        renderModLane(mod, pinnedY, this.lanesLayer, true);
        if (i > 0) {
          const sep = new Graphics();
          sep.moveTo(0, pinnedY + laneH);
          sep.lineTo(this.width, pinnedY + laneH);
          sep.stroke({ width: 1, color: 0x282828 });
          this.lanesLayer.addChild(sep);
        }
        pinnedY -= LANE_GAP;
      }
    }

    this._threads.forEach((thread, i) => {
      const laneY = this._threadLaneY(i);
      const laneH = this._threadLaneHeight(thread);
      const color = THREAD_LANE_COLORS[i % THREAD_LANE_COLORS.length];
      const expanded = true;
      const isActive = thread.threadId === this._activeThreadId;

      const bg = new Graphics();
      bg.rect(0, laneY, this.width, laneH);
      bg.fill(expanded ? 0x242a2f : 0x1d2227);
      bg.rect(0, laneY, this.width, laneH);
      bg.stroke({ width: isActive ? 2.5 : 1, color: isActive ? color : 0x2d3a42 });
      bg.eventMode = 'static';
      bg.cursor = 'pointer';

      bg.on('pointerdown', (evt) => {
        if (evt.shiftKey) {
          evt.stopPropagation();
          this._startRangeZoomDrag(evt.global.x);
          return;
        }
        evt.stopPropagation();
        if (isActive) {
          this.updateTimeFromPosition(evt.global.x);
          this.emitTimeCommit();
          return;
        }
        this.setActiveThreadId(thread.threadId, { notify: true });
      });

      bg.on('pointermove', (evt) => {
        this._hoveredThreadId = thread.threadId;
        this._showThreadTooltip(thread, evt.global.x, evt.global.y);
      });

      bg.on('pointerout', () => {
        this._hoveredThreadId = null;
        this._hideTooltip();
      });

      this.lanesLayer.addChild(bg);

      const ribbonH = Math.max(3, laneH - 2 * RIBBON_PAD);
      const ribbonY = laneY + RIBBON_PAD;
      const lifetimes = thread.lifetimes?.length > 0
        ? thread.lifetimes
        : (thread.createPosition || thread.terminatePosition
          ? [{ createPosition: thread.createPosition, terminatePosition: thread.terminatePosition }]
          : []);

      lifetimes.forEach(lt => {
        const ribbon = this._buildRibbon(lt.createPosition, lt.terminatePosition, ribbonY, ribbonH, plotWidth, color);
        if (ribbon) this.lanesLayer.addChild(ribbon);
      });

      const label = new Text({
        text: `TID ${thread.threadId ?? '?'}${thread.procSymbol?.available ? ` ${thread.procSymbol.name}` : ''}`,
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: expanded ? 11 : 9,
          fill: isActive ? color : (expanded ? 0xa8d5f7 : 0x708a99),
        },
      });
      label.x = Math.max(this.leftPad, plotX - 8 - label.width);
      label.y = laneY + (laneH - label.height) / 2;
      this.lanesLayer.addChild(label);

      // Active thread badge
      if (isActive) {
        const badge = new Text({ text: '[A]', style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 9, fill: color } });
        badge.x = this.leftPad;
        badge.y = laneY + (laneH - badge.height) / 2;
        this.lanesLayer.addChild(badge);
      }
    });

      this.renderEvents();
  }

    _normalizeModuleToken(value) {
      if (!value) return '';
      let token = String(value).trim().toLowerCase();
      const bang = token.indexOf('!');
      if (bang >= 0) token = token.slice(0, bang);
      token = token.replace(/^.*[\\/]/, '');
      token = token.replace(/\.dll$/i, '');
      return token;
    }

    _indexModuleLane(mod, laneY, laneH, color) {
      const center = laneY + laneH / 2;
      const add = (token) => {
        const key = this._normalizeModuleToken(token);
        if (!key) return;
        this._moduleLaneCenterByKey.set(key, { y: center, color });
      };

      add(mod.moduleId);
      add(mod.name);
      add(mod.path);
    }

    _resolveEventModuleToken(event) {
      if (!event) return '';
      if (event.module) return this._normalizeModuleToken(event.module);
      if (event.function) return this._normalizeModuleToken(event.function);
      if (event.rawFunction) return this._normalizeModuleToken(event.rawFunction);
      return '';
    }

    _resolveModuleForEvent(event) {
      const token = this._resolveEventModuleToken(event);
      if (!token) return null;

      return this._modules.find((mod) => {
        const candidates = [mod.moduleId, mod.name, mod.path]
          .map((value) => this._normalizeModuleToken(value))
          .filter(Boolean);
        return candidates.includes(token);
      }) ?? null;
    }

    _pinModulesForEvents(events) {
      let changed = false;
      events.forEach((event) => {
        const mod = this._resolveModuleForEvent(event);
        if (!mod || mod.isMain === true) return;
        if (this._pinned[mod.moduleId] !== true) {
          this._pinned[mod.moduleId] = true;
          changed = true;
        }
      });
      return changed;
    }

    _eventWorldNorm(event) {
      if (event?.time != null) {
        const denom = this.timeRange.end - this.timeRange.start;
        if (denom > 0) {
          return Math.max(0, Math.min(1, (event.time - this.timeRange.start) / denom));
        }
        return null;
      }

      if (!this.majorRange || !event?.startPosition?.major) return null;
      try {
        const major = BigInt(event.startPosition.major);
        const span = this.majorRange.end - this.majorRange.start;
        if (span <= 0n) return null;
        const clamped = major < this.majorRange.start
          ? this.majorRange.start
          : (major > this.majorRange.end ? this.majorRange.end : major);
        const scaled = ((clamped - this.majorRange.start) * 1000000n) / span;
        return Number(scaled) / 1000000;
      } catch {
        return null;
      }
    }

  /**
   * Build a colored ribbon (horizontal bar) for one lifetime range.
   * ribbonY/ribbonH define the vertical slot inside the lane.
   */
  _buildRibbon(loadPos, unloadPos, ribbonY, ribbonH, plotWidth, color) {
    const plotX = this.getPlotX();

    if (!this.majorRange) {
      // No time bounds yet - full-width placeholder
      const g = new Graphics();
      g.roundRect(plotX, ribbonY, plotWidth, ribbonH, Math.min(3, ribbonH / 3));
      g.fill({ color, alpha: 0.22 });
      return g;
    }

    const visible = this._getVisibleMajorRange();
    if (!visible) return null;
    const rangeStart = visible.start;
    const rangeEnd   = visible.end;
    if (rangeEnd <= rangeStart) return null;

    let xStart = plotX;
    let xEnd   = plotX + plotWidth;

    try {
      if (loadPos?.available && loadPos.major != null) {
        const v = BigInt(loadPos.major);
        xStart = this.mapBigIntToX(v < rangeStart ? rangeStart : v, rangeStart, rangeEnd, plotWidth);
      }
      if (unloadPos?.available && unloadPos.major != null) {
        const v = BigInt(unloadPos.major);
        xEnd = this.mapBigIntToX(v > rangeEnd ? rangeEnd : v, rangeStart, rangeEnd, plotWidth);
      }
    } catch {
      return null;
    }

    // Clip ribbon to visible plot area.
    xStart = Math.max(plotX, xStart);
    xEnd = Math.min(plotX + plotWidth, xEnd);
    if (xEnd <= xStart) return null;

    const w = Math.max(2, xEnd - xStart);
    const r = Math.min(3, ribbonH / 3);
    const g = new Graphics();

    // Detect full-width span: if ribbon touches both edges, draw with inward chamfers.
    const isFullWidth = xStart <= plotX && xEnd >= plotX + plotWidth;
    if (isFullWidth) {
      // Draw body with no corner rounding
      g.rect(xStart, ribbonY, w, ribbonH);
      g.fill({ color, alpha: 0.80 });
      g.rect(xStart, ribbonY, w, ribbonH);
      g.stroke({ width: 1, color, alpha: 1 });

      // Inward chamfers at left and right: small triangles at top-left, bottom-left, top-right, bottom-right
      const chamfSize = Math.min(6, ribbonH / 2, w / 4);
      const chamferColor = color;
      // Top-left inward chamfer
      g.moveTo(xStart, ribbonY);
      g.lineTo(xStart + chamfSize, ribbonY);
      g.lineTo(xStart, ribbonY + chamfSize);
      g.fill(chamferColor);
      // Bottom-left inward chamfer
      g.moveTo(xStart, ribbonY + ribbonH);
      g.lineTo(xStart + chamfSize, ribbonY + ribbonH);
      g.lineTo(xStart, ribbonY + ribbonH - chamfSize);
      g.fill(chamferColor);
      // Top-right inward chamfer
      g.moveTo(xEnd, ribbonY);
      g.lineTo(xEnd - chamfSize, ribbonY);
      g.lineTo(xEnd, ribbonY + chamfSize);
      g.fill(chamferColor);
      // Bottom-right inward chamfer
      g.moveTo(xEnd, ribbonY + ribbonH);
      g.lineTo(xEnd - chamfSize, ribbonY + ribbonH);
      g.lineTo(xEnd, ribbonY + ribbonH - chamfSize);
      g.fill(chamferColor);
    } else {
      // Normal rounded corners for non-full-width ribbons
      g.roundRect(xStart, ribbonY, w, ribbonH, r);
      g.fill({ color, alpha: 0.80 });
      g.roundRect(xStart, ribbonY, w, ribbonH, r);
      g.stroke({ width: 1, color, alpha: 1 });
    }

    return g;
  }

  /** Ensure scrubber and axis stay rendered on top of lanes. */
  _bringOverlaysToFront() {
    if (this.minimap)       this.container.addChild(this.minimap);
    if (this._rangeZoomOverlay) this.container.addChild(this._rangeZoomOverlay);
    if (this.scrubber)      this.container.addChild(this.scrubber);
    if (this.scrubberLabel) this.container.addChild(this.scrubberLabel);
    this.container.addChild(this.axisLayer);
  }

  _showTooltip(module, x, y) {
    if (!this.tooltipDiv) return;
    const addr = module.baseAddress ? `0x${module.baseAddress.toString(16).toUpperCase()}` : 'unknown';
    const size = module.imageSize ? `${(module.imageSize / 1024 / 1024).toFixed(2)} MB` : 'unknown';
    const loadMajor = module.loadPosition?.available ? module.loadPosition.major : 'N/A';
    const loadMinor = module.loadPosition?.available ? module.loadPosition.minor : 'N/A';
    const unloadMajor = module.unloadPosition?.available ? module.unloadPosition.major : 'N/A';
    const unloadMinor = module.unloadPosition?.available ? module.unloadPosition.minor : 'N/A';
    const isMain = module.isMain === true;
    const isPinned = this._pinned[module.moduleId] === true;
    const pinHint = isMain
      ? 'Main module is always pinned'
      : (isPinned ? 'Press Spacebar to unpin the module' : 'Press Spacebar to pin the module');

    const info = `${module.name || module.path || 'Module'}\nBase: ${addr}\nSize: ${size}\nLoad: ${loadMajor}:${loadMinor}\nUnload: ${unloadMajor}:${unloadMinor}`;
    this.tooltipDiv.textContent = '';
    const infoBlock = document.createElement('div');
    infoBlock.style.whiteSpace = 'pre';
    infoBlock.textContent = info;
    const hintBlock = document.createElement('div');
    hintBlock.style.marginTop = '6px';
    hintBlock.style.color = '#ffd54f';
    hintBlock.textContent = `Hint: ${pinHint}`;
    this.tooltipDiv.appendChild(infoBlock);
    this.tooltipDiv.appendChild(hintBlock);
    this.tooltipDiv.style.display = 'block';
    this.tooltipDiv.style.left = `${x - 10}px`;
    this.tooltipDiv.style.top = `${y + 10}px`;
    this.tooltipDiv.style.transform = 'translateX(-100%)';
  }

  _showThreadTooltip(thread, x, y) {
    if (!this.tooltipDiv) return;
    const createMajor = thread.createPosition?.available ? thread.createPosition.major : 'N/A';
    const createMinor = thread.createPosition?.available ? thread.createPosition.minor : 'N/A';
    const termMajor = thread.terminatePosition?.available ? thread.terminatePosition.major : 'N/A';
    const termMinor = thread.terminatePosition?.available ? thread.terminatePosition.minor : 'N/A';
    const symbol = thread.procSymbol?.available ? thread.procSymbol.name : 'unknown';
    const info = `Thread ${thread.threadId ?? '?'}\nStart: ${symbol}\nCreate: ${createMajor}:${createMinor}\nTerminate: ${termMajor}:${termMinor}`;
    const isActive = thread.threadId === this._activeThreadId;
    const hint = isActive
      ? `Active thread\nPos: ${this._getHoverPositionLabel(x)}`
      : 'Press Spacebar to set active thread';
    this.tooltipDiv.textContent = '';
    const infoBlock = document.createElement('div');
    infoBlock.style.whiteSpace = 'pre';
    infoBlock.textContent = info;
    const hintBlock = document.createElement('div');
    hintBlock.style.marginTop = '6px';
    hintBlock.style.color = '#ffd54f';
    hintBlock.textContent = `Hint: ${hint}`;
    this.tooltipDiv.appendChild(infoBlock);
    this.tooltipDiv.appendChild(hintBlock);
    this.tooltipDiv.style.display = 'block';
    this.tooltipDiv.style.left = `${x - 10}px`;
    this.tooltipDiv.style.top = `${y + 10}px`;
    this.tooltipDiv.style.transform = 'translateX(-100%)';
  }

  _hideTooltip() {
    if (this.tooltipDiv) {
      this.tooltipDiv.style.display = 'none';
    }
  }

  setActive(active) {
    const nextActive = active === true;
    if (this._isActive === nextActive) return;
    this._isActive = nextActive;

    if (nextActive) return;

    // Ensure timeline hover overlays never persist when switching tabs.
    const hadHoverState = this._hoveredModuleId != null
      || this._hoveredThreadId != null
      || this._hoveredSyncedEvent != null
      || this._isAxisHovering;

    this._hoveredModuleId = null;
    this._hoveredThreadId = null;
    this._hoveredSyncedEvent = null;
    this._hideTooltip();
    this._setAxisHoverState(false);

    if (hadHoverState) {
      this._updateMarkerVisuals();
      this._renderLanes();
      this._bringOverlaysToFront();
    }
  }

  createMinimap() {
    this.minimap = new Graphics();
    this._drawMinimapBase();
    this.container.addChild(this.minimap);
  }

  _drawMinimapBase() {
    this.minimap.clear();
    this.minimap.rect(this.getPlotX(), 2, this.getPlotWidth(), MINIMAP_H);
    this.minimap.fill(0x1e1e1e);
    this.minimap.rect(this.getPlotX(), 2, this.getPlotWidth(), MINIMAP_H);
    this.minimap.stroke({ width: 1, color: 0x3c3c3c });
  }

  updateMinimap() {
    const plotWidth = this.getPlotWidth();
    const bucketCount = Math.max(20, Math.floor(plotWidth / 2));
    const bucketSize = (this.timeRange.end - this.timeRange.start) / bucketCount;
    const densityMap = new Array(bucketCount).fill(0);

    this.events.forEach(event => {
      const norm = this._eventWorldNorm(event);
      if (norm == null) return;
      const eventTime = this.timeRange.start + norm * (this.timeRange.end - this.timeRange.start);
      const bucket = Math.floor((eventTime - this.timeRange.start) / bucketSize);
      if (bucket >= 0 && bucket < bucketCount) densityMap[bucket]++;
    });

    const maxDensity = Math.max(...densityMap, 1);

    const plotX = this.getPlotX();
    this.minimap.clear();
    this.minimap.rect(plotX, 2, plotWidth, MINIMAP_H);
    this.minimap.fill(0x1e1e1e);

    densityMap.forEach((count, i) => {
      if (count > 0) {
        const barH = (count / maxDensity) * (MINIMAP_H - 2);
        const x = plotX + (i / bucketCount) * plotWidth;
        const w = Math.max(1, plotWidth / bucketCount);
        this.minimap.rect(x, 2 + (MINIMAP_H - barH), w, barH);
        this.minimap.fill(0x4ec9b0);
      }
    });

    this.minimap.rect(plotX, 2, plotWidth, MINIMAP_H);
    this.minimap.stroke({ width: 1, color: 0x3c3c3c });
  }

  // ---------------------------------------------------------------------------
  // Scrubber
  // ---------------------------------------------------------------------------

  createScrubber() {
    this.scrubber = new Graphics();
    this.updateScrubberPosition();
    this.container.addChild(this.scrubber);

    this.scrubberLabel = new Text({
      text: '',
      style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 10, fill: 0xffd54f },
    });
    this.scrubberLabel.visible = true;
    this.container.addChild(this.scrubberLabel);
  }

  createRangeZoomOverlay() {
    this._rangeZoomOverlay = new Graphics();
    this._rangeZoomOverlay.visible = false;
    this.container.addChild(this._rangeZoomOverlay);
  }

  updateScrubberPosition() {
    if (!this.scrubber) return;
    this.scrubber.clear();

    const visible = this._getVisibleTimeWindow();
    const denom = visible.end - visible.start;
    const normalizedTime = denom > 0
      ? (this.currentTime - visible.start) / denom
      : 0;
    const x = this.getPlotX() + Math.max(0, Math.min(1, normalizedTime)) * this.getPlotWidth();

    const lineTop    = this._lanesTop;
    const lineBottom = this._axisY;

    const hovered = this.isScrubberHovered || this.isDraggingScrubber;

    // Glow layers (rendered furthest-back → front when hovered)
    if (hovered) {
      this.scrubber.moveTo(x, lineTop);
      this.scrubber.lineTo(x, lineBottom);
      this.scrubber.stroke({ width: 9, color: 0xff6b6b, alpha: 0.12 });

      this.scrubber.moveTo(x, lineTop);
      this.scrubber.lineTo(x, lineBottom);
      this.scrubber.stroke({ width: 5, color: 0xff8a80, alpha: 0.25 });

      this.scrubber.moveTo(x, lineTop);
      this.scrubber.lineTo(x, lineBottom);
      this.scrubber.stroke({ width: 2.5, color: 0xffb3b3, alpha: 0.55 });
    }

    this.scrubber.moveTo(x, lineTop);
    this.scrubber.lineTo(x, lineBottom);
    this.scrubber.stroke({ width: hovered ? 1.5 : 1, color: hovered ? 0xffa0a0 : 0xff6b6b, alpha: hovered ? 1 : 0.7 });

    // Emphasize the scrubber segment crossing the active thread lane.
    const activeLane = this._getActiveThreadLaneSpan();
    if (activeLane) {
      const segTop = Math.max(lineTop, activeLane.top);
      const segBottom = Math.min(lineBottom, activeLane.bottom);
      if (segBottom > segTop) {
        // White glow layers — always visible
        this.scrubber.moveTo(x, segTop);
        this.scrubber.lineTo(x, segBottom);
        this.scrubber.stroke({ width: 11, color: 0xffffff, alpha: 0.08 });

        this.scrubber.moveTo(x, segTop);
        this.scrubber.lineTo(x, segBottom);
        this.scrubber.stroke({ width: 6, color: 0xffffff, alpha: 0.18 });

        this.scrubber.moveTo(x, segTop);
        this.scrubber.lineTo(x, segBottom);
        this.scrubber.stroke({ width: 3, color: 0xffffff, alpha: 0.40 });

        // Black outline to separate from lane background
        this.scrubber.moveTo(x, segTop);
        this.scrubber.lineTo(x, segBottom);
        this.scrubber.stroke({ width: 3.5, color: 0x000000, alpha: 0.70 });

        // Bright white core
        this.scrubber.moveTo(x, segTop);
        this.scrubber.lineTo(x, segBottom);
        this.scrubber.stroke({ width: 1.5, color: 0xffffff, alpha: 1 });
      }
    }

    // Handle (anchored near x-axis)
    const handleR = hovered ? 7 : 5;
    const handleY = lineBottom - 6;
    if (hovered) {
      // outer glow ring
      this.scrubber.circle(x, handleY, handleR + 5);
      this.scrubber.fill({ color: 0xff6b6b, alpha: 0.12 });
      this.scrubber.circle(x, handleY, handleR + 3);
      this.scrubber.fill({ color: 0xff8a80, alpha: 0.22 });
    }
    this.scrubber.circle(x, handleY, handleR);
    this.scrubber.fill(hovered ? 0xff8a80 : 0xff6b6b);
    this.scrubber.circle(x, handleY, handleR);
    this.scrubber.stroke({ width: hovered ? 1.5 : 1, color: 0xffffff, alpha: hovered ? 1 : 0.9 });

    this.updateScrubberLabel(x);

    this.scrubber.hitArea = {
      x: x - 10, y: lineTop, width: 20, height: lineBottom - lineTop,
      contains(px, py) {
        return px >= this.x && px <= this.x + this.width &&
               py >= this.y && py <= this.y + this.height;
      },
    };
  }

  _getActiveThreadLaneSpan() {
    if (this._activeThreadId == null) return null;
    const index = this._threads.findIndex((thread) => thread.threadId === this._activeThreadId);
    if (index < 0) return null;

    const top = this._threadLaneY(index);
    const laneH = this._threadLaneHeight(this._threads[index]);
    return {
      top,
      bottom: top + laneH,
    };
  }

  // ---------------------------------------------------------------------------
  // Interactions
  // ---------------------------------------------------------------------------

  setupInteractions() {
    this.scrubber.eventMode = 'static';
    this.scrubber.cursor = 'pointer';

    this.scrubber.on('pointerdown', (e) => {
      if (e.shiftKey) {
        this._startRangeZoomDrag(e.global.x);
        return;
      }
      this.isDraggingScrubber = true;
      this.updateTimeFromPosition(e.global.x);
    });
    this.scrubber.on('pointerover', () => { this.isScrubberHovered = true;  this.updateScrubberPosition(); });
    this.scrubber.on('pointerout',  () => { this.isScrubberHovered = false; this.updateScrubberPosition(); });

    this.container.eventMode = 'static';
    this.container.on('pointermove', (e) => {
      this._updateAxisHover(e.global.x, e.global.y);
      if (this._isRangeZoomDragging) {
        this._updateRangeZoomDrag(e.global.x);
      }
      if (this.isDraggingScrubber) this.updateTimeFromPosition(e.global.x);
    });
    this.container.on('pointerup',        () => {
      if (this._isRangeZoomDragging) {
        this._finishRangeZoomDrag(true);
        return;
      }
      const wasDragging = this.isDraggingScrubber;
      this.isDraggingScrubber = false;
      this.updateScrubberPosition();
      if (wasDragging) this.emitTimeCommit();
    });
    this.container.on('pointerupoutside', () => {
      if (this._isRangeZoomDragging) {
        this._finishRangeZoomDrag(true);
        return;
      }
      const wasDragging = this.isDraggingScrubber;
      this.isDraggingScrubber = false;
      this.updateScrubberPosition();
      if (wasDragging) this.emitTimeCommit();
    });

    this.background.eventMode = 'static';
    this.background.cursor = 'pointer';
    this.background.on('pointerdown', (e) => {
      if (e.shiftKey) {
        this._startRangeZoomDrag(e.global.x);
        return;
      }
      if (!this.isDraggingScrubber) {
        this.updateTimeFromPosition(e.global.x);
        this.emitTimeCommit();
      }
    });
    this.background.on('pointerout', () => {
      this._setAxisHoverState(false);
    });

    // Wheel over modules/threads/axis: zoom x-axis; Shift+wheel pans x-axis.
    this.container.on('wheel', (e) => {
      this._handleWheelAxisInteraction(e);
    });

    // Bind Space hotkey once so resize() does not duplicate handlers.
    if (!this._spaceHotkeyBound) {
      window.addEventListener('keydown', this._onWindowKeyDown);
      this._spaceHotkeyBound = true;
    }
  }

  _handleWindowKeyDown(e) {
    if (!e) return;
    const hasHoveredEvent = this._hoveredSyncedEvent != null;
    const jumpKey = e.code === 'Enter' || e.key === 'Enter' || e.code === 'KeyJ' || e.key === 'j' || e.key === 'J';
    if (jumpKey && hasHoveredEvent && !this._isTypingTarget(e.target)) {
      this.onSyncedEventJump?.(this._hoveredSyncedEvent);
      e.preventDefault();
      return;
    }

    if ((e.code === 'KeyR' || e.key === 'r' || e.key === 'R') && !this._isTypingTarget(e.target)) {
      this._resetXAxisView();
      this.renderXAxis();
      this.updateScrubberPosition();
      this._renderLanes();
      this._bringOverlaysToFront();
      e.preventDefault();
      return;
    }

    if ((e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z') && !this._isTypingTarget(e.target)) {
      this._zoomToActiveThread();
      e.preventDefault();
      return;
    }
    if (e.code !== 'Space' && e.key !== ' ') return;
    if (this._isTypingTarget(e.target)) return;
    if (this._activateHoveredThread()) {
      e.preventDefault();
      return;
    }
    if (this._toggleHoveredModulePin()) {
      e.preventDefault();
    }
  }

  _isTypingTarget(target) {
    if (!target || typeof target !== 'object') return false;
    const tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  _isInAxisArea(localY) {
    const hoverTop = Math.max(this._lanesTop, this._axisY - 12);
    return localY >= hoverTop && localY <= this.height;
  }

  _updateAxisHover(globalX, globalY) {
    const localY = globalY - this.container.y;
    const active = this._isInAxisArea(localY);
    this._setAxisHoverState(active, globalX, globalY);
  }

  _setAxisHoverState(active, globalX = 0, globalY = 0) {
    if (this._isAxisHovering !== active) {
      this._isAxisHovering = active;
      this.renderXAxis();
      this._bringOverlaysToFront();
    }

    if (!this.axisHintDiv) return;
    if (!active) {
      this.axisHintDiv.style.display = 'none';
      return;
    }

    const posLabel = this._getHoverPositionLabel(globalX);
    const zoomHint = this._zoomLimitReached
      ? '\nMax zoom reached: minimum window is 10 majors'
      : '';
    this.axisHintDiv.textContent = `Pos: ${posLabel}\nWheel: Zoom X  |  Shift+Wheel: Pan X  |  Shift+Drag: Zoom Range  |  R: Reset${zoomHint}`;
    this.axisHintDiv.style.display = 'block';
    this.axisHintDiv.style.left = `${globalX + 14}px`;
    this.axisHintDiv.style.top = `${globalY - 26}px`;
  }

  _getHoverPositionLabel(globalX) {
    const localX = globalX - this.container.x;
    const plotX = this.getPlotX();
    const plotWidth = this.getPlotWidth();
    const xNorm = Math.max(0, Math.min(1, (localX - plotX) / plotWidth));
    const worldNorm = this._xViewStartNorm + xNorm * (this._xViewEndNorm - this._xViewStartNorm);

    if (!this.majorRange) {
      const visible = this._getVisibleTimeWindow();
      const time = visible.start + xNorm * (visible.end - visible.start);
      return `${Math.round(time)}:0`;
    }

    const sm = BigInt(Math.round(this.majorRange.startMinor ?? 0));
    const em = BigInt(Math.round(this.majorRange.endMinor   ?? 0));
    const startAbs = this.majorRange.start * MINOR_PER_MAJOR + sm;
    const endAbs   = this.majorRange.end   * MINOR_PER_MAJOR + em;
    const span     = endAbs - startAbs;
    if (span <= 0n) return '?:?';
    const PREC = 1000000n;
    const w      = Math.max(0, Math.min(1, worldNorm));
    const offset = (span * BigInt(Math.round(w * Number(PREC)))) / PREC;
    const absPos = startAbs + offset;
    const major  = absPos / MINOR_PER_MAJOR;
    const minor  = Number(absPos % MINOR_PER_MAJOR);
    return `${this.formatMajorLabel(major)}:${minor}`;
  }

  _toggleHoveredModulePin() {
    if (this._hoveredModuleId == null) return false;
    const mod = this._modules.find(m => m.moduleId === this._hoveredModuleId);
    if (!mod) return false;

    // Main module always stays in the pinned group.
    if (mod.isMain === true) return false;

    const currentlyPinned = this._pinned[mod.moduleId] === true;
    this._pinned[mod.moduleId] = !currentlyPinned;
    this.setModules(this._modules);
    return true;
  }

  _activateHoveredThread() {
    if (this._hoveredThreadId == null) return false;
    return this.setActiveThreadId(this._hoveredThreadId, { notify: true });
  }

  updateTimeFromPosition(globalX) {
    const localX = globalX - this.container.x;
    const normalizedX = Math.max(0, Math.min(1, (localX - this.getPlotX()) / this.getPlotWidth()));
    const visible = this._getVisibleTimeWindow();
    const newTime = visible.start + normalizedX * (visible.end - visible.start);
    this.setTime(newTime);
    if (this.onTimeChange) this.onTimeChange(this.currentTime);
  }

  emitTimeCommit() {
    if (this.onTimeCommit) this.onTimeCommit(this.currentTime);
  }

  setTime(time) {
    this.currentTime = Math.max(this.timeRange.start, Math.min(this.timeRange.end, time));
    this.updateScrubberPosition();
  }

  setTimeRange(start, end) {
    this.timeRange = { start, end };
    this._resetXAxisView();
    this.renderXAxis();
    this.renderEvents();
  }

  // ---------------------------------------------------------------------------
  // Major-range (TTD positions)
  // ---------------------------------------------------------------------------

  setMajorRange(startMajor, endMajor, startMinor = null, endMinor = null) {
    if (startMajor == null || endMajor == null) {
      this.majorRange = null;
      this._resetXAxisView();
      this.renderXAxis();
      this.updateScrubberPosition();
      this._renderLanes(); // redraw bars (they go full-width when no range)
      return;
    }
    try {
      const start = BigInt(startMajor);
      const end   = BigInt(endMajor);
      this.majorRange = end > start
        ? { start, end, startMinor: this.toOptionalNumber(startMinor), endMinor: this.toOptionalNumber(endMinor) }
        : null;
    } catch {
      this.majorRange = null;
    }
    this._resetXAxisView();
    this.renderXAxis();
    this.updateScrubberPosition();
    this._renderLanes(); // re-position lifespan bars
    this._bringOverlaysToFront();
  }

  // ---------------------------------------------------------------------------
  // Events (Phase 4+, kept for compatibility)
  // ---------------------------------------------------------------------------

  setEvents(events) {
    this.events = Array.isArray(events) ? events : [];
    const pinChanged = this._pinModulesForEvents(this.events);
    if (pinChanged) {
      this.setModules(this._modules);
      return;
    }
    this.renderEvents();
  }

  renderEvents() {
    this.tracksContainer.removeChildren();
    this._hoveredSyncedEvent = null;
    this._syncedMarkers = [];

    if (this.events.length > 0) {
      const plotX = this.getPlotX();
      const plotW = this.getPlotWidth();
      const viewSpan = this._xViewEndNorm - this._xViewStartNorm;
      this.events.forEach((event) => {
        const moduleToken = this._resolveEventModuleToken(event);
        const lane = this._moduleLaneCenterByKey.get(moduleToken);
        if (!lane) return;

        const worldNorm = this._eventWorldNorm(event);
        if (worldNorm == null || viewSpan <= 0) return;

        const viewNorm = (worldNorm - this._xViewStartNorm) / viewSpan;
        if (viewNorm < 0 || viewNorm > 1) return;

        const x = plotX + viewNorm * plotW;
        const laneColor = lane.color ?? 0xffd54f;
        const marker = new Graphics();
        const meta = { gfx: marker, event, x, laneY: lane.y, laneColor };
        this._syncedMarkers.push(meta);

        this._drawMarker(meta, false);

        marker.eventMode = 'static';
        marker.cursor = 'pointer';
        marker.on('pointermove', (evt) => {
          if (this._hoveredSyncedEvent !== event) {
            this._hoveredSyncedEvent = event;
            this._updateMarkerVisuals();
          }
          this._showSyncedEventTooltip(event, evt.global.x, evt.global.y);
        });
        marker.on('pointerout', () => {
          this._hoveredSyncedEvent = null;
          this._updateMarkerVisuals();
          this._hideTooltip();
        });
        marker.on('pointerdown', (evt) => {
          evt.stopPropagation();
          this.onSyncedEventJump?.(event);
        });
        this.tracksContainer.addChild(marker);
      });
    }

    this.updateMinimap();
  }

  _drawMarker(meta, isHovered) {
    const { gfx, x, laneY, laneColor } = meta;
    gfx.clear();
    const r = isHovered ? 7 : 4.5;
    const outlineColor = isHovered ? 0xffffff : laneColor;
    const outlineWidth = isHovered ? 2 : 1.2;
    gfx.circle(x, laneY, r);
    gfx.fill({ color: 0x000000 });
    gfx.circle(x, laneY, r);
    gfx.stroke({ width: outlineWidth, color: outlineColor });
  }

  _updateMarkerVisuals() {
    const hasHover = this._hoveredSyncedEvent != null;
    for (const meta of this._syncedMarkers) {
      const isHovered = hasHover && meta.event === this._hoveredSyncedEvent;
      meta.gfx.alpha = hasHover && !isHovered ? 0.35 : 1.0;
      this._drawMarker(meta, isHovered);
      // bring hovered marker to front
      if (isHovered) {
        this.tracksContainer.setChildIndex(meta.gfx, this.tracksContainer.children.length - 1);
      }
    }
  }

  _showSyncedEventTooltip(event, x, y) {
    if (!this.tooltipDiv) return;
    const fn = event?.function ?? event?.rawFunction ?? '(unknown)';
    const mod = event?.module ?? 'unknown';
    const thread = event?.threadId ?? '?';
    const start = `${event?.startPosition?.major ?? '?'}:${event?.startPosition?.minor ?? 0}`;
    const end = `${event?.endPosition?.major ?? '?'}:${event?.endPosition?.minor ?? 0}`;
    const summary = event?.summary ?? '';

    const info = `${fn}\nModule: ${mod}\nThread: ${thread}\nStart: ${start}\nEnd: ${end}`;
    this.tooltipDiv.textContent = '';

    const infoBlock = document.createElement('div');
    infoBlock.style.whiteSpace = 'pre';
    infoBlock.textContent = info;
    this.tooltipDiv.appendChild(infoBlock);

    if (summary) {
      const summaryBlock = document.createElement('div');
      summaryBlock.style.marginTop = '6px';
      summaryBlock.style.color = '#d8d8d8';
      summaryBlock.style.maxWidth = '360px';
      summaryBlock.style.whiteSpace = 'normal';
      summaryBlock.textContent = summary;
      this.tooltipDiv.appendChild(summaryBlock);
    }

    const hintBlock = document.createElement('div');
    hintBlock.style.marginTop = '6px';
    hintBlock.style.color = '#ffd54f';
    hintBlock.textContent = 'Hint: Enter/J to open this event in Function Calls tab';
    this.tooltipDiv.appendChild(hintBlock);

    this.tooltipDiv.style.display = 'block';
    this.tooltipDiv.style.left = `${x - 10}px`;
    this.tooltipDiv.style.top = `${y + 10}px`;
    this.tooltipDiv.style.transform = 'translateX(-100%)';
  }

  // ---------------------------------------------------------------------------
  // X-axis
  // ---------------------------------------------------------------------------

  renderXAxis() {
    this.axisLayer.removeChildren();
    const plotX     = this.getPlotX();
    const plotWidth = this.getPlotWidth();
    const axisY     = this._axisY;

    if (this._isAxisHovering) {
      const hoverTop = Math.max(this._lanesTop, axisY - 12);
      const hoverH = Math.max(14, this.height - hoverTop - 2);
      const outline = new Graphics();
      outline.roundRect(plotX, hoverTop, plotWidth, hoverH, 4);
      outline.stroke({ width: 1, color: 0xffd54f, alpha: 0.95 });
      this.axisLayer.addChild(outline);
    }

    const axis = new Graphics();
    axis.moveTo(plotX, axisY);
    axis.lineTo(plotX + plotWidth, axisY);
    axis.stroke({ width: 1, color: 0x3c3c3c });
    this.axisLayer.addChild(axis);

    if (this._zoomLimitReached) {
      const badge = new Text({
        text: 'MAX ZOOM (10 majors min)',
        style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 10, fill: 0xffb74d, fontWeight: 'bold' },
      });
      badge.x = plotX + plotWidth - badge.width - 6;
      badge.y = Math.max(2, axisY - 22);
      this.axisLayer.addChild(badge);
    }

    if (this.majorRange) {
      const visible = this._getVisibleMajorRange();
      if (!visible) return;
      this.renderMajorTicks(visible.start, visible.end, axisY, plotWidth);
      this.renderMajorBoundaries(visible.start, visible.end, axisY, plotWidth);
    } else {
      const visible = this._getVisibleTimeWindow();
      this.renderNumericTicks(visible.start, visible.end, axisY, plotWidth);
    }
  }

  renderMajorTicks(startMajor, endMajor, axisY, plotWidth) {
    const range = endMajor - startMajor;
    if (range <= 0n) return;
    const step = this.chooseWholeMajorStep(range);
    let tick = ((startMajor + step - 1n) / step) * step;
    let guard = 0;
    while (tick <= endMajor && guard < 200) {
      if (tick !== startMajor && tick !== endMajor) {
        const x = this.mapBigIntToX(tick, startMajor, endMajor, plotWidth);
        this.drawTickAndLabel(x, axisY, this.formatMajorLabel(tick));
      }
      tick += step;
      guard++;
    }
  }

  renderMajorBoundaries(startMajor, endMajor, axisY, plotWidth) {
    const hTick = 0xff4d4d;
    const hText = 0xff6b6b;
    const startLabel = `${this.formatMajorLabel(startMajor)}:${this.getBoundaryMinor('start')}`;
    const endLabel   = `${this.formatMajorLabel(endMajor)}:${this.getBoundaryMinor('end')}`;
    this.drawTickAndLabel(this.getPlotX(),              axisY, startLabel, hTick, hText);
    this.drawTickAndLabel(this.getPlotX() + plotWidth,  axisY, endLabel,   hTick, hText);
  }

  renderNumericTicks(start, end, axisY, plotWidth) {
    const range = end - start;
    if (range <= 0) return;
    const step  = this.chooseNumericStep(range);
    const first = Math.ceil(start / step) * step;
    for (let tick = first, i = 0; tick <= end && i < 200; tick += step, i++) {
      const x = this.getPlotX() + ((tick - start) / range) * plotWidth;
      this.drawTickAndLabel(x, axisY, `${Math.round(tick)}`);
    }
  }

  drawTickAndLabel(x, axisY, labelText, tickColor = 0x6d6d6d, textColor = 0x9a9a9a) {
    const tick = new Graphics();
    tick.moveTo(x, axisY);
    tick.lineTo(x, axisY - 6);
    tick.stroke({ width: 1, color: tickColor });
    this.axisLayer.addChild(tick);

    const label = new Text({
      text: labelText,
      style: { fontFamily: 'Consolas, Monaco, monospace', fontSize: 9, fill: textColor },
    });
    label.x = x - label.width / 2;
    label.y = axisY + 1;
    this.axisLayer.addChild(label);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  chooseWholeMajorStep(range) {
    const targetTicks = 8n;
    const raw = (range + targetTicks - 1n) / targetTicks;
    if (raw <= 1n) return 1n;
    const digits = raw.toString().length - 1;
    const pow10  = 10n ** BigInt(digits);
    const lead   = Number(raw / pow10);
    if (lead <= 1) return pow10;
    if (lead <= 2) return 2n * pow10;
    if (lead <= 5) return 5n * pow10;
    return 10n * pow10;
  }

  chooseNumericStep(range) {
    const raw  = range / 8;
    if (raw <= 1) return 1;
    const exp  = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const n    = raw / base;
    if (n <= 1) return base;
    if (n <= 2) return 2 * base;
    if (n <= 5) return 5 * base;
    return 10 * base;
  }

  _resetXAxisView() {
    this._setXAxisView(0, 1);
  }

  _zoomToActiveThread() {
    if (!this.majorRange || this._activeThreadId == null) return;
    const thread = this._threads.find(t => t.threadId === this._activeThreadId);
    if (!thread) return;

    const lifetimes = thread.lifetimes?.length > 0
      ? thread.lifetimes
      : [{ createPosition: thread.createPosition, terminatePosition: thread.terminatePosition }];

    // Find the earliest createPosition and latest terminatePosition across all lifetimes
    let startPos = null;
    let endPos   = null;

    for (const lt of lifetimes) {
      if (lt?.createPosition?.available) {
        if (!startPos || BigInt(lt.createPosition.major) < BigInt(startPos.major)) {
          startPos = lt.createPosition;
        }
      }
      if (lt?.terminatePosition?.available) {
        if (!endPos || BigInt(lt.terminatePosition.major) > BigInt(endPos.major)) {
          endPos = lt.terminatePosition;
        }
      }
    }

    // If no valid positions, zoom to full range
    if (!startPos || !endPos || !startPos.available || !endPos.available) {
      this._resetXAxisView();
      return;
    }

    // Convert exact major:minor positions to world norms using accurate pipeline
    const startNorm = this._worldNormFromPosition(startPos);
    const endNorm   = this._worldNormFromPosition(endPos);

    if (startNorm == null || endNorm == null) {
      this._resetXAxisView();
      return;
    }

    // Check if thread spans full recording range
    const isFullSpan = startNorm <= 0.00001 && endNorm >= 0.99999;

    // Apply small padding unless full-span
    let finalStart = startNorm;
    let finalEnd = endNorm;

    if (!isFullSpan) {
      const viewSpan = endNorm - startNorm;
      const pad = viewSpan * 0.02; // 2% padding each side
      finalStart = Math.max(0, startNorm - pad);
      finalEnd   = Math.min(1, endNorm + pad);
    }

    this._setXAxisView(finalStart, finalEnd);
    this.renderXAxis();
    this.updateScrubberPosition();
    this._renderLanes();
    this._bringOverlaysToFront();
  }

  _setXAxisView(startNorm, endNorm) {
    let s = Number.isFinite(startNorm) ? startNorm : 0;
    let e = Number.isFinite(endNorm) ? endNorm : 1;
    if (e < s) [s, e] = [e, s];

    const minSpan = this._getMinZoomSpanNorm();
    let span = e - s;
    if (span < minSpan) {
      const mid = (s + e) / 2;
      s = mid - minSpan / 2;
      e = mid + minSpan / 2;
      span = minSpan;
    }
    if (span > 1) {
      s = 0;
      e = 1;
      span = 1;
    }

    if (s < 0) {
      e -= s;
      s = 0;
    }
    if (e > 1) {
      s -= (e - 1);
      e = 1;
    }

    s = Math.max(0, Math.min(1 - minSpan, s));
    e = Math.max(s + minSpan, Math.min(1, e));
    this._xViewStartNorm = s;
    this._xViewEndNorm = e;
    this._zoomLimitReached = this._isAtMinZoomSpan();
  }

  _isAtMinZoomSpan() {
    const span = this._xViewEndNorm - this._xViewStartNorm;
    const minSpan = this._getMinZoomSpanNorm();
    return span <= (minSpan + 1e-12);
  }

  _getMinZoomSpanNorm() {
    let minSpan = this._xZoomMinSpan;
    if (this.majorRange) {
      const totalMajors = this.majorRange.end - this.majorRange.start;
      if (totalMajors > 0n) {
        const minMajorsInView = 10n;
        if (totalMajors <= minMajorsInView) {
          return 1;
        }
        const scale = 1000000000n;
        const ratioScaled = (minMajorsInView * scale + totalMajors - 1n) / totalMajors;
        const majorsLimited = Number(ratioScaled) / Number(scale);
        if (Number.isFinite(majorsLimited)) {
          minSpan = Math.max(minSpan, majorsLimited);
        }
      }
    }
    return Math.max(this._xZoomMinSpan, Math.min(1, minSpan));
  }

  _zoomXAxis(rawDelta, anchorNorm) {
    const span = this._xViewEndNorm - this._xViewStartNorm;
    const zoomFactor = Math.exp(rawDelta * 0.0012);
    const minSpan = this._getMinZoomSpanNorm();
    const newSpan = Math.max(minSpan, Math.min(1, span * zoomFactor));
    const anchor = Math.max(0, Math.min(1, anchorNorm));
    const anchorWorld = this._xViewStartNorm + anchor * span;
    const newStart = anchorWorld - anchor * newSpan;
    this._setXAxisView(newStart, newStart + newSpan);
    return rawDelta < 0 && this._zoomLimitReached;
  }

  _handleWheelAxisInteraction(e) {
    const rawDelta = e?.deltaY ?? e?.deltaX ?? e?.originalEvent?.deltaY ?? 0;
    if (!rawDelta) return;

    const localY = e.global.y - this.container.y;
    const inTimelineBand = localY >= this._lanesTop && localY <= this._axisY;
    if (!inTimelineBand) return;

    const anchorNorm = this._anchorNormFromGlobalX(e.global.x);
    if (e.shiftKey) {
      this._panXAxis(rawDelta * 0.0012);
    } else {
      this._zoomXAxis(rawDelta, anchorNorm);
    }

    this.renderXAxis();
    this.updateScrubberPosition();
    this._renderLanes();
    this._bringOverlaysToFront();
  }

  _anchorNormFromGlobalX(globalX) {
    const localX = globalX - this.container.x;
    const plotX = this.getPlotX();
    const plotW = this.getPlotWidth();
    return Math.max(0, Math.min(1, (localX - plotX) / plotW));
  }

  _startRangeZoomDrag(globalX) {
    this._isRangeZoomDragging = true;
    this._rangeZoomStartGlobalX = globalX;
    this._rangeZoomCurrentGlobalX = globalX;
    this._drawRangeZoomOverlay();
  }

  _updateRangeZoomDrag(globalX) {
    this._rangeZoomCurrentGlobalX = globalX;
    this._drawRangeZoomOverlay();
  }

  _finishRangeZoomDrag(applyZoom) {
    if (!this._isRangeZoomDragging) return;

    const leftGlobalX = Math.min(this._rangeZoomStartGlobalX, this._rangeZoomCurrentGlobalX);
    const rightGlobalX = Math.max(this._rangeZoomStartGlobalX, this._rangeZoomCurrentGlobalX);

    const startNorm = this._anchorNormFromGlobalX(leftGlobalX);
    const endNorm = this._anchorNormFromGlobalX(rightGlobalX);
    const minNorm = Math.min(startNorm, endNorm);
    const maxNorm = Math.max(startNorm, endNorm);

    this._isRangeZoomDragging = false;
    if (this._rangeZoomOverlay) {
      this._rangeZoomOverlay.clear();
      this._rangeZoomOverlay.visible = false;
    }

    if (!applyZoom) return;
    if ((maxNorm - minNorm) < 0.00001) {
      this._flashRangeAnchorHint(this._rangeZoomStartGlobalX, 950, this._zoomLimitReached);
      return;
    }

    const prevStart = this._xViewStartNorm;
    const prevEnd = this._xViewEndNorm;

    const leftPos = this._positionFromGlobalX(leftGlobalX);
    const rightPos = this._positionFromGlobalX(rightGlobalX);

    if (leftPos?.major != null && rightPos?.major != null) {
      const nextStart = this._worldNormFromPosition(leftPos);
      const nextEnd = this._worldNormFromPosition(rightPos);
      if (nextStart != null && nextEnd != null && (nextEnd - nextStart) > 1e-6) {
        this._setXAxisView(nextStart, nextEnd);
      } else {
        const span = this._xViewEndNorm - this._xViewStartNorm;
        this._setXAxisView(this._xViewStartNorm + minNorm * span, this._xViewStartNorm + maxNorm * span);
      }
    } else {
      const span = this._xViewEndNorm - this._xViewStartNorm;
      this._setXAxisView(this._xViewStartNorm + minNorm * span, this._xViewStartNorm + maxNorm * span);
    }

    const unchanged = Math.abs(this._xViewStartNorm - prevStart) < 1e-12
      && Math.abs(this._xViewEndNorm - prevEnd) < 1e-12;
    if (unchanged && this._zoomLimitReached) {
      this._flashRangeAnchorHint(this._rangeZoomStartGlobalX, 1100, true);
    }

    this.renderXAxis();
    this.updateScrubberPosition();
    this._renderLanes();
    this._bringOverlaysToFront();
  }

  _drawRangeZoomOverlay() {
    if (!this._rangeZoomOverlay) return;
    const plotX = this.getPlotX();
    const plotW = this.getPlotWidth();
    const top = this._lanesTop;
    const height = Math.max(6, this._axisY - this._lanesTop);

    const startNorm = this._anchorNormFromGlobalX(this._rangeZoomStartGlobalX);
    const endNorm = this._anchorNormFromGlobalX(this._rangeZoomCurrentGlobalX);
    const minNorm = Math.min(startNorm, endNorm);
    const maxNorm = Math.max(startNorm, endNorm);
    const startX = plotX + startNorm * plotW;
    const x = plotX + minNorm * plotW;
    const w = Math.max(1, (maxNorm - minNorm) * plotW);

    this._rangeZoomOverlay.clear();

    // Bright start-anchor hint so users can always see where range drag began.
    this._rangeZoomOverlay.moveTo(startX, top);
    this._rangeZoomOverlay.lineTo(startX, top + height);
    this._rangeZoomOverlay.stroke({ width: 2, color: 0x79d2ff, alpha: 0.95 });
    this._rangeZoomOverlay.circle(startX, top + 6, 3.5);
    this._rangeZoomOverlay.fill({ color: 0x79d2ff, alpha: 1 });

    this._rangeZoomOverlay.roundRect(x, top, w, height, 4);
    this._rangeZoomOverlay.fill({ color: 0x5aa0ff, alpha: 0.15 });
    this._rangeZoomOverlay.roundRect(x, top, w, height, 4);
    this._rangeZoomOverlay.stroke({ width: 1, color: 0x8bc3ff, alpha: 0.95 });
    this._rangeZoomOverlay.visible = true;
  }

  _flashRangeAnchorHint(globalX, durationMs = 950, noMoreZoom = false) {
    if (!this._rangeZoomOverlay) return;
    if (this._rangeAnchorHintTimer) {
      clearTimeout(this._rangeAnchorHintTimer);
      this._rangeAnchorHintTimer = null;
    }

    const plotX = this.getPlotX();
    const plotW = this.getPlotWidth();
    const top = this._lanesTop;
    const height = Math.max(6, this._axisY - this._lanesTop);
    const anchorNorm = this._anchorNormFromGlobalX(globalX);
    const anchorX = plotX + anchorNorm * plotW;
    const color = noMoreZoom ? 0xffb74d : 0x79d2ff;

    this._rangeZoomOverlay.clear();
    this._rangeZoomOverlay.moveTo(anchorX, top);
    this._rangeZoomOverlay.lineTo(anchorX, top + height);
    this._rangeZoomOverlay.stroke({ width: 3, color, alpha: 1 });
    this._rangeZoomOverlay.circle(anchorX, top + 6, 4.5);
    this._rangeZoomOverlay.fill({ color, alpha: 1 });
    this._rangeZoomOverlay.visible = true;

    this._rangeAnchorHintTimer = setTimeout(() => {
      this._rangeAnchorHintTimer = null;
      if (this._isRangeZoomDragging) return;
      this._rangeZoomOverlay?.clear();
      if (this._rangeZoomOverlay) this._rangeZoomOverlay.visible = false;
    }, durationMs);
  }

  _positionFromGlobalX(globalX) {
    const xNorm = this._anchorNormFromGlobalX(globalX);
    const worldNorm = this._xViewStartNorm + xNorm * (this._xViewEndNorm - this._xViewStartNorm);

    if (!this.majorRange) {
      const visible = this._getVisibleTimeWindow();
      return {
        time: visible.start + xNorm * (visible.end - visible.start),
      };
    }

    const sm = BigInt(Math.round(this.majorRange.startMinor ?? 0));
    const em = BigInt(Math.round(this.majorRange.endMinor   ?? 0));
    const startAbs = this.majorRange.start * MINOR_PER_MAJOR + sm;
    const endAbs   = this.majorRange.end   * MINOR_PER_MAJOR + em;
    const span     = endAbs - startAbs;
    if (span <= 0n) return null;
    const PREC = 1000000n;
    const w      = Math.max(0, Math.min(1, worldNorm));
    const offset = (span * BigInt(Math.round(w * Number(PREC)))) / PREC;
    const absPos = startAbs + offset;
    const major  = absPos / MINOR_PER_MAJOR;
    const minor  = Number(absPos % MINOR_PER_MAJOR);
    return { major, minor };
  }

  _worldNormFromPosition(position) {
    if (!position || !this.majorRange || position.major == null) return null;

    let major;
    try { major = BigInt(position.major); } catch { return null; }

    const minor = BigInt(Math.round(
      Number.isFinite(position.minor) ? Math.max(0, position.minor) : 0
    ));

    const sm = BigInt(Math.round(this.majorRange.startMinor ?? 0));
    const em = BigInt(Math.round(this.majorRange.endMinor   ?? 0));
    const startAbs = this.majorRange.start * MINOR_PER_MAJOR + sm;
    const endAbs   = this.majorRange.end   * MINOR_PER_MAJOR + em;
    const span     = endAbs - startAbs;
    if (span <= 0n) return null;

    // Clamp position to recording bounds before computing norm.
    let absPos = major * MINOR_PER_MAJOR + minor;
    if (absPos < startAbs) absPos = startAbs;
    if (absPos > endAbs)   absPos = endAbs;

    const PREC = 1000000n;
    return Math.max(0, Math.min(1,
      Number(((absPos - startAbs) * PREC) / span) / Number(PREC)
    ));
  }

  _panXAxis(delta) {
    const span = this._xViewEndNorm - this._xViewStartNorm;
    const shift = delta * span;
    this._setXAxisView(this._xViewStartNorm + shift, this._xViewEndNorm + shift);
  }

  _getVisibleTimeWindow() {
    const total = this.timeRange.end - this.timeRange.start;
    const start = this.timeRange.start + total * this._xViewStartNorm;
    const end = this.timeRange.start + total * this._xViewEndNorm;
    return { start, end };
  }

  _getVisibleMajorRange() {
    if (!this.majorRange) return null;
    const total = this.majorRange.end - this.majorRange.start;
    if (total <= 0n) return null;

    const scale = 1000000n;
    const sNorm = BigInt(Math.round(this._xViewStartNorm * Number(scale)));
    const eNorm = BigInt(Math.round(this._xViewEndNorm * Number(scale)));
    let start = this.majorRange.start + (total * sNorm) / scale;
    let end = this.majorRange.start + (total * eNorm) / scale;
    if (end <= start) end = start + 1n;
    return { start, end };
  }

  _getActiveThreadTimeBounds() {
    if (this._activeThreadId == null || !this.majorRange) return null;
    const thread = this._threads.find(t => t.threadId === this._activeThreadId);
    if (!thread) return null;

    const lifetimes = thread.lifetimes?.length > 0
      ? thread.lifetimes
      : [{ createPosition: thread.createPosition, terminatePosition: thread.terminatePosition }];

    let startMajor = null;
    let endMajor = null;
    for (const lt of lifetimes) {
      if (lt?.createPosition?.available && lt.createPosition.major != null) {
        const v = BigInt(lt.createPosition.major);
        startMajor = startMajor == null || v < startMajor ? v : startMajor;
      }
      if (lt?.terminatePosition?.available && lt.terminatePosition.major != null) {
        const v = BigInt(lt.terminatePosition.major);
        endMajor = endMajor == null || v > endMajor ? v : endMajor;
      }
    }

    const majorStart = this.majorRange.start;
    const majorEnd = this.majorRange.end;
    if (majorEnd <= majorStart) return null;
    if (startMajor == null) startMajor = majorStart;
    if (endMajor == null) endMajor = majorEnd;

    if (startMajor < majorStart) startMajor = majorStart;
    if (endMajor > majorEnd) endMajor = majorEnd;
    if (endMajor <= startMajor) return null;

    const majorSpan = Number(majorEnd - majorStart);
    if (!Number.isFinite(majorSpan) || majorSpan <= 0) return null;
    const startNorm = Number(startMajor - majorStart) / majorSpan;
    const endNorm = Number(endMajor - majorStart) / majorSpan;

    const timeSpan = this.timeRange.end - this.timeRange.start;
    return {
      start: this.timeRange.start + startNorm * timeSpan,
      end: this.timeRange.start + endNorm * timeSpan,
    };
  }

  mapBigIntToX(value, start, end, plotWidth) {
    const scaled = ((value - start) * 1000000n) / (end - start);
    return this.getPlotX() + (Number(scaled) / 1000000) * plotWidth;
  }

  formatMajorLabel(value) {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  updateScrubberLabel(x) {
    if (!this.scrubberLabel) return;
    this.scrubberLabel.visible = true;
    this.scrubberLabel.text = this.getCurrentPositionLabel();
    this.scrubberLabel.x = Math.min(
      Math.max(this.getPlotX(), x + 8),
      this.getPlotX() + this.getPlotWidth() - this.scrubberLabel.width,
    );
    this.scrubberLabel.y = this._axisY - this.scrubberLabel.height - 2;
  }

  getCurrentPositionLabel() {
    if (!this.majorRange) return `${Math.round(this.currentTime)}:0`;
    const normalized = this.getNormalizedCurrentTime();
    const major = this.majorRange.start +
      ((this.majorRange.end - this.majorRange.start) * BigInt(Math.round(normalized * 1000000))) / 1000000n;
    const startMinor = this.majorRange.startMinor ?? 0;
    const endMinor   = this.majorRange.endMinor   ?? 0;
    const minor = Math.max(0, Math.round(startMinor + (endMinor - startMinor) * normalized));
    return `${this.formatMajorLabel(major)}:${minor}`;
  }

  getNormalizedCurrentTime() {
    const denom = this.timeRange.end - this.timeRange.start;
    if (denom <= 0) return 0;
    return Math.max(0, Math.min(1, (this.currentTime - this.timeRange.start) / denom));
  }

  getBoundaryMinor(side) {
    if (!this.majorRange) return 0;
    return side === 'start' ? (this.majorRange.startMinor ?? 0) : (this.majorRange.endMinor ?? 0);
  }

  toOptionalNumber(value) {
    if (value == null) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  resize(width, height) {
    this.width  = width;
    this.height = height;
    this.container.removeChildren();
    this.lanesLayer     = new Container();
    this.tracksContainer = new Container();
    this.axisLayer      = new Container();
    this.initialize();
    this._renderLanes();
    this.renderEvents();
  }

  update() {
    // Animation hook - reserved for future smooth scrubber motion.
  }

  // Callback set by App
  onTimeChange = null;
  onTimeCommit = null;
  onThreadSelect = null;
  onSyncedEventJump = null;
}

