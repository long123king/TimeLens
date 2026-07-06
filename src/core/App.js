import DataManager from './DataManager.js';
import Viewport from './Viewport.js';
import Timeline from '../components/Timeline.js';
import MemoryView from '../components/MemoryView.js';
import MemoryPageView from '../components/MemoryPageView.js';
import MemoryPageSvgView from '../components/MemoryPageSvgView.js';
import Controls from '../components/Controls.js';
import ApiClient from '../api/ApiClient.js';
import ConnectionMonitor from '../api/ConnectionMonitor.js';
import ConnectionPanel from '../components/ConnectionPanel.js';
import NotificationBar from '../components/NotificationBar.js';
import CommandConsole from '../components/CommandConsole.js';
import FunctionCallBrowser from '../components/FunctionCallBrowser.js';
import MemoryLayoutView from '../components/MemoryLayoutView.js';
import EnvironmentView from '../components/EnvironmentView.js';
import ModelView from '../components/ModelView.js';
import PeView from '../components/PeView.js';
import StringsView from '../components/StringsView.js';
import MemAccessView from '../components/MemAccessView.js';
import FlameGraphView from '../components/FlameGraphView.js';
import QueueView from '../components/QueueView.js';
import PositionView from '../components/PositionView.js';
import HomeView from '../components/HomeView.js';
import ReplayBar from '../components/ReplayBar.js';
import StorylineRecorder from './StorylineRecorder.js';
import StorylinePlayer from './StorylinePlayer.js';
import StorylineInterceptor from '../api/StorylineInterceptor.js';
import { MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL } from '../utils/ZoomController.js';
import { getPeSectionPermission, getPeSectionSpan, parsePeBigInt } from '../utils/PeSectionUtils.js';
import { treemap, treemapSquarify, hierarchy } from 'd3-hierarchy';

const TIMELINE_HEIGHT = 220; // fallback only; actual height from viewport.timelineHeight

/**
 * App - Main application controller
 * Coordinates all components and manages application state
 */
export default class App {
  constructor(pixiApp, options = {}) {
    this.pixiApp = pixiApp;
    this._storylineArchive = options.storylineArchive || options.storylinArchive || null;
    // API layer must be created before DataManager so callstack requests
    // flow through the shared request queue
    this.apiClient = new ApiClient();
    this.connectionMonitor = new ConnectionMonitor(this.apiClient);
    this.dataManager = new DataManager(this.apiClient);
    this.viewport = new Viewport(pixiApp);
    this._recorder = null;       // StorylineRecorder (recording mode)
    this._player = null;         // StorylinePlayer (replay mode)

    // Application state
    this.state = {
      currentTime: 0,
      maxTime: 10000,
      currentPosition: null,
      isPlaying: false,
      playbackSpeed: 1,
      zoomLevel: MIN_ZOOM_LEVEL,
      selectedAddress: null,
      memoryData: null,
      events: [],
      activeTab: 'timeline',
      selectedPeImageBase: '',
    };

     // Phase 1: communication channel state
     this.state.traceInfo = null;   // trace sub-object from /api/ttd/trace-info
     this.state.timeBounds = null;  // { first: {major,minor}, last: {major,minor} }

     // Phase 2: module lane data
     this.state.modules = [];       // array from /api/ttd/modules
    this.state.threads = [];       // array from /api/ttd/threads
    this.state.activeThreadId = null;

    this.connectionPanel = null;   // set in initialize() once DOM is ready
     this.notificationBar = null;   // set in initialize() once DOM is ready
    this.commandConsole = null;
    this.functionCallBrowser = null;
    this.memoryLayoutView = null;
    this.environmentView = null;
    this.modelView = null;
    this.peView = null;
    this.stringsView = null;
    this.memaccessView = null;
    this.flamegraphView = null;
    this.queueView = null;
    this.replayBar = null;
    this.positionView = null;
    this.homeView = null;
    this._threadLifetimes = new Map(); // threadId → { start, end }
    this._sectionPermissions = [];     // [{start: BigInt, end: BigInt, perm: string}] from PE sections
    this.latestRegisters = null;

    // Components
    this.timeline = null;
    this.memoryView = null;
    this.memoryPageView = null;
    this.controls = null;
  }

  async initialize() {
    console.log('Initializing application...');

      // Wire up connection diagnostics UI
      this.connectionPanel = new ConnectionPanel(document.getElementById('connection-panel'));
      this.notificationBar = new NotificationBar(document.getElementById('notification-bar'));
      this.connectionPanel.onStopRequested = () => this._requestServerStop();
      this.connectionPanel.setDisconnected();

      // ReplayBar is independent of the rest of the workspace, so mount it
      // early so _initReplayMode can drive it before initializeComponents().
      this.replayBar = new ReplayBar();
      this.replayBar.onPrev = () => this._player?.retreat();
      this.replayBar.onNext = () => this._player?.advance();
      this.replayBar.onReset = async () => {
        if (!this._player) return;
        await this._player.goTo(0);
      };
      this.replayBar.hide();

      document.querySelectorAll('[data-nav]').forEach(el => {
        if (el.closest('#workspace-tabs')) return;
        el.addEventListener('click', (e) => {
          const target = el.getAttribute('data-nav');
          if (!target) return;
          if (target === 'position' && el.id === 'info-position') {
            const pos = this.state.currentPosition;
            const tid = this.state.activeThreadId;
            if (pos?.major != null) {
              this._openPosition(pos.major, Number(pos.minor ?? 0), tid);
            } else {
              this.setActiveTab('position');
              this._recordUserAction('tab-switch', { tabTarget: 'position' }, 'Tab → "position"');
            }
          } else if (target === 'position') {
            this.setActiveTab('position');
            this._recordUserAction('tab-switch', { tabTarget: 'position' }, 'Tab → "position"');
          } else {
            this.setActiveTab(target);
            this._recordUserAction('tab-switch', { tabTarget: target }, `Tab → "${target}"`);
          }
        });
      });

      this.connectionMonitor.onStateChange = (connected, serverData) =>
        this._handleConnectionChange(connected, serverData);
      this.connectionMonitor.onStatusUpdate = (statusResponse) =>
        this._handleStatusUpdate(statusResponse);

      if (this._isReplayMode()) {
        await this._initReplayMode();
      }

      this.connectionMonitor.start();

      // Load scaffold data (falls back to mock until Phase 2-5 routes are live)
      await this.loadInitialData();

    if (!this._isReplayMode()) {
      this._recorder = new StorylineRecorder(this.apiClient);
    }

    // Initialize components
    this.initializeComponents();

    // Setup UI controls
    this.setupControls();
    this.setupTabs();

    // Setup animation loop
    this.setupAnimationLoop();

    this._initialized = true;
    console.log('Application initialized');
  }

  async loadInitialData() {
    // Visualization data populated from live backend once connected.
    this.state.memoryData = null;
    this.state.events = [];
  }

  _isReplayMode() {
    return !!this._storylineArchive;
  }

  async _initReplayMode() {
    let archive = this._storylineArchive;
    // Filter out spurious timeline-seek steps that are artifacts of the
    // thread-select handler (it used to call handleTimeCommit, which
    // recorded an extra timeline-seek). A spurious step has the form
    // timeline-seek followed by a thread-select with the same timestamp.
    archive = this._stripSpuriousTimelineSeeks(archive);
    this._storylineArchive = archive;

    const interceptor = new StorylineInterceptor();
    this.apiClient.setInterceptor(interceptor);

    this._player = new StorylinePlayer(archive, this.apiClient, interceptor);

    const refreshReplayBar = () => {
      if (!this.replayBar || !this._player) return;
      const idx = this._player.currentIndex;
      // Before any step is applied (idx === -1) preview step 0 so the
      // user knows what Next will do; afterwards show the just-applied step.
      const step = this._player.currentStep
                ?? (this._player.totalSteps > 0 ? this._player.steps[0] : null);
      this.replayBar.setCurrentStep(
        idx,
        this._player.totalSteps,
        step?.type ?? '',
        step?.description ?? '',
      );
      this.replayBar.setAvailability({
        canAdvance: this._player.canAdvance,
        canRetreat: this._player.canRetreat,
      });
    };

    this._player.onStepReplayed = (index) => {
      refreshReplayBar();
      const step = this._player.currentStep;
      if (step) {
        this.notificationBar.show(
          `Step ${index + 1}/${archive.stepCount}: ${step.type} — ${step.description}`,
          'info',
        );
      }
    };

    this._player.setActionHandlers({
      'init': () => {},
      'tab-switch': (a) => { this.setActiveTab(a.tabTarget); },
      'timeline-seek': (a) => {
        // Switch to the Timeline tab so the user can see the seek
        // happen. Without this, a timeline-seek recorded while the user
        // was on another tab (e.g. after a module-click) produces no
        // visible UI change during replay.
        this.setActiveTab('timeline');
        if (a.time != null) this.state.currentTime = a.time;
        this.handleTimeCommit(this.state.currentTime, a.position ?? null);
      },
      'thread-select': (a) => {
        // Switch to the Timeline tab so the user can see the thread
        // selection update in the thread lanes.
        this.setActiveTab('timeline');
        this.state.activeThreadId = a.threadId;
        this._renderTimelineThreadsMeta();
        this.timeline?.setActiveThreadId(a.threadId);
        this.handleTimeCommit(this.state.currentTime);
      },
      'address-click': (a) => { this.handleAddressSelect(a.address); },
      'module-click': (a) => {
        if (a?.target === 'pe') {
          this._openModuleInPe(a.address);
        } else {
          this._openModuleInMemoryLayout(a.address);
        }
      },
      'position-open': (a) => {
        this.setActiveTab('position');
        this.positionView?.load(a.major, a.minor, a.threadId);
      },
      'page-navigate': (a) => {
        this.setActiveTab('page');
        this._navigatePageSvg(a.address);
      },
      'search': (a) => { this._replaySearch(a); },
      'command': (a) => { this._replayCommand(a); },
      'mem-access': (a) => { this._replayMemAccess(a); },
      'flamegraph': (a) => { this._replayFlamegraph(a); },
      'auto': (a) => { /* no UI side-effect for 'auto' steps */ },
    });

    this._player.setResetHandler(async () => {
      this.state.currentTime = 0;
      this.state.currentPosition = null;
      this.state.activeTab = 'timeline';
      this.state.activeThreadId = null;
      this.state.selectedAddress = null;
      this.state.selectedPeImageBase = '';
      this.setActiveTab('timeline');
      refreshReplayBar();
    });

    interceptor.loadArchive(archive);

    this.replayBar?.show();
    refreshReplayBar();

    this.notificationBar.show(
      `Replay mode — ${archive.stepCount} steps, ${archive.requestCount} requests. Press Space / Shift+Space to step.`,
      'info',
    );

    // Establish the home/reset state but DO NOT auto-apply step 0.
    // The user starts the replay from a clean Timeline view and
    // explicitly advances with Next / Space.
    if (this._player._onReset) {
      await this._player._onReset();
    }
    refreshReplayBar();
  }

  // -- replay action handlers ------------------------------------------------

  _replaySearch(action) {
    const category = action?.category;
    const query = action?.searchQuery ?? action?.query ?? '';
    if (category === 'function-calls') {
      this.setActiveTab('function');
      if (this.functionCallBrowser && query) {
        this.functionCallBrowser.input.value = String(query);
        this.functionCallBrowser.handleSubmit();
      }
    } else if (category === 'strings') {
      this.setActiveTab('strings');
      if (this.stringsView && query) {
        this.stringsView._queryInput.value = String(query);
        if (action?.limit) this.stringsView._limitInput.value = String(action.limit);
        this.stringsView._submitSearch();
      }
    }
  }

  async _replayCommand(action) {
    const command = action?.commandText;
    if (!command) return;
    this.setActiveTab('command');
    if (this.commandConsole) {
      if (this.commandConsole.input) {
        this.commandConsole.input.value = String(command);
      }
      await this.commandConsole.handleSubmit();
      // CommandConsole.handleSubmit clears the input in its finally block
      // (normal user flow). For replay we want the command to remain
      // visible in the input so the user can see what was just executed,
      // matching how function-calls / strings / mem-access retain their
      // inputs after submit.
      if (this.commandConsole.input) {
        this.commandConsole.input.value = String(command);
      }
    }
  }

  _replayMemAccess(action) {
    const startAddr = action?.startAddr;
    const endAddr = action?.endAddr;
    const mode = action?.mode ?? 'W';
    if (!this.memaccessView) {
      this.setActiveTab('memaccess');
      return;
    }
    this.setActiveTab('memaccess');
    const view = this.memaccessView;
    this.apiClient.drainQueue();
    requestAnimationFrame(() => {
      view.acceptPrefill(String(startAddr), String(endAddr), String(mode));
      if (action?.timeStartPct != null && view._timeStartPctInput) {
        view._timeStartPctInput.value = String(action.timeStartPct);
      }
      if (action?.timeEndPct != null && view._timeEndPctInput) {
        view._timeEndPctInput.value = String(action.timeEndPct);
      }
      // Only re-fire a search when the original action had a time range
      // (i.e. this was a recorded Search click, not just a flamegraph prefill).
      if (action?.timeStartPct != null || action?.timeEndPct != null) {
        view._submitSearch();
      }
    });
  }

  _replayFlamegraph(action) {
    // Show the Flame Graph tab. The frame the user clicked is already
    // present in the view's rendered data (loaded from the fixture map
    // when the tab was first activated), so we do NOT re-fire onClickFrame:
    // doing so would call _openMemAccessRange and navigate away from this
    // tab to memaccess, which is the wrong destination for a flamegraph
    // step (mem-access is its own separate step in the archive).
    this.setActiveTab('flamegraph');
  }

  /**
   * Load a storyline archive and enter replay mode at runtime.
   * Safe to call before initialize() — the archive will be picked up
   * once initialization reaches the replay-mode branch.
   */
  loadStorylineArchive(archive) {
    if (!archive || !Array.isArray(archive.steps)) {
      this.notificationBar?.show('Invalid storyline archive (missing steps[])', 'error');
      return false;
    }
    this._storylineArchive = archive;
    if (this._isReplayMode() && this._initialized) {
      this._initReplayMode().catch((err) => {
        this.notificationBar?.show(`Replay init failed: ${err.message}`, 'error');
      });
    } else {
      this.notificationBar?.show(
        `Storyline queued (${archive.stepCount} steps) — will load after init`,
        'info',
      );
    }
    return true;
  }

  _getRecordedCallstackFramesForThread(threadId) {
    if (!this._storylineArchive?.steps?.length) return [];
    const target = String(threadId);
    const out = [];
    for (const step of this._storylineArchive.steps) {
      for (const req of (step?.requests ?? [])) {
        if (!req?.path?.startsWith('/api/callstack?')) continue;
        if (req.status < 200 || req.status >= 300) continue;
        const m = /(?:^|&)(?:thread_id|threadId)=([^&]+)/.exec(req.path);
        if (!m || decodeURIComponent(m[1]) !== target) continue;
        const frames = req.responseBody?.frames;
        if (Array.isArray(frames) && frames.length > 0) {
          out.push(req.responseBody);
        }
      }
    }
    return out;
  }

  _stripSpuriousTimelineSeeks(archive) {
    if (!archive?.steps?.length) return archive;
    const out = [];
    for (let i = 0; i < archive.steps.length; i++) {
      const step = archive.steps[i];
      const next = archive.steps[i + 1];
      // Drop a timeline-seek step that is immediately followed by a
      // thread-select with the same timestamp. Such a step was a recording
      // artifact of the thread-select handler (it called handleTimeCommit
      // internally, which recorded a no-op timeline-seek).
      if (step?.type === 'timeline-seek'
          && next?.type === 'thread-select'
          && step.timestamp === next.timestamp) {
        continue;
      }
      out.push(step);
    }
    if (out.length === archive.steps.length) return archive;
    return { ...archive, steps: out, stepCount: out.length };
  }

  async _recordUserAction(type, action = {}, description = '') {
    if (!this._recorder) return;
    // Coalesce mem-access: a probe is a single user action, regardless of
    // how many progressive Search clicks the user did within it. When a
    // mem-access action follows a mem-access step, overwrite the last step
    // in place so the archive stores the final probe state.
    if (type === 'mem-access') {
      const last = this._recorder.getLastStep();
      if (last?.type === 'mem-access') {
        last._coalesced = true;
        try { await this.apiClient.waitForIdle(3000); } catch {}
        const requests = this.apiClient.drainRecordingBuffer();
        last.action = action;
        last.description = description;
        last.timestamp = Date.now();
        last.relativeMs = Date.now() - this._recorder.startTime;
        last.requests = requests ?? [];
        return;
      }
    }
    const step = this._recorder.startStep(type, action, description);
    try {
      await this.apiClient.waitForIdle(3000);
    } catch {}
    const requests = this.apiClient.drainRecordingBuffer();
    this._recorder.commitStep(step, requests);
  }

    // ---------- Phase 1 connection handling ----------------------------------

    _handleConnectionChange(connected, serverData) {
      if (connected) {
        this._fetchTraceInfo(serverData);
      } else {
        this.connectionPanel.setDisconnected();
        this.memoryLayoutView?.setDisconnected();
        this.environmentView?.setDisconnected();
        this.modelView?.setDisconnected();
        this.peView?.setDisconnected();
        this.stringsView?.setDisconnected();
        this.memaccessView?.setDisconnected();
        this.flamegraphView?.setDisconnected();
        this.queueView?.setDisconnected();
        this.replayBar?.hide();
        this.positionView?.setDisconnected();
        this.homeView?.setDisconnected();
        if (this.state.traceInfo !== null) {
          this.notificationBar.show('dk server disconnected', 'warning');
        }
        this.state.traceInfo = null;
        this.state.timeBounds = null;
        this.state.modules = [];
        this.state.threads = [];
        this._threadLifetimes = new Map();
        this.state.activeThreadId = null;
        this.state.selectedPeImageBase = '';
        this.state.currentPosition = null;
        if (this.timeline) {
          this.timeline.setMajorRange(null, null, null, null);
          this.timeline.setThreadsTopOffset(0);
          this.timeline.setThreads([]);
        }
        this._renderTimelineModules();
        this._renderTimelineThreadsMeta();
      }
    }

    _handleStatusUpdate(statusResponse) {
      const server = statusResponse?.server;
      if (!server) return;
      // Keep uptime live between trace refreshes without reloading trace/modules.
      this.connectionPanel?.setConnected(server, this.state.traceInfo);
    }

    async _fetchTraceInfo(serverData) {
      try {
        const response = await this.apiClient.getTraceInfo();
        const trace = response.trace ?? null;
        this.state.traceInfo = trace;
        this.connectionPanel.setConnected(serverData?.server, trace);
        // Pass trace info to mem-access view for time range display
        this.memaccessView?.setTraceInfo(trace);
        this.homeView?.setTraceInfo(trace);

        if (trace?.available && trace?.firstPos && trace?.lastPos) {
          this.state.timeBounds = { first: trace.firstPos, last: trace.lastPos };
          this.state.currentPosition = {
            major: String(trace.firstPos.major),
            minor: Number(trace.firstPos.minor ?? 0),
          };
          if (this.timeline) {
            this.timeline.setMajorRange(
              trace.firstPos.major,
              trace.lastPos.major,
              trace.firstPos.minor,
              trace.lastPos.minor,
            );
          }
          this.positionView?.setTraceBounds(this.state.timeBounds);
          this.homeView?.setTraceBounds(this.state.timeBounds);
        }
      } catch (err) {
        // Server is up but trace-info failed — show partial status
        this.connectionPanel.setConnected(serverData?.server, null);
        this.notificationBar.show(`Trace info unavailable: ${err.message}`, 'error');
      }

      // Phase 2: ensure modules loaded before threads trigger position loads
      await this._fetchModules();
      this._fetchThreads();
      this._fetchThreadLifetimes();
      this._fetchMemoryLayout();
      this._fetchEnvironment();
      this._refreshModelHome();
      this._fetchPe();

      // Enable all tabs now that core data is loaded
      this._enableAllTabs();
    }

    _enableAllTabs() {
      if (this._tabsReady) return;
      this._tabsReady = true;
      document.querySelectorAll('[data-tab-target]').forEach((button) => {
        button.disabled = false;
      });

      if (this._recorder && this._recorder.steps.length === 0) {
        this._recorder.captureInit();
      }
    }

    async _fetchModules() {
      try {
        const response = await this.apiClient.getModules();
        const modules = response.modules ?? [];
        this.state.modules = modules;
        this._renderTimelineModules();
        // Build section-permission cache for page classification. This must
        // finish before we enable tabs — otherwise a user clicking into
        // Position/Page before the cache is ready will get a false "data
        // page" classification for every address.
        await this._buildSectionPermissionCache(modules);
      } catch (err) {
        this.notificationBar.show(`Module data unavailable: ${err.message}`, 'warning');
      }
    }

    async _buildSectionPermissionCache(modules) {
      const sections = [];
      const failures = [];
      for (const m of (modules ?? [])) {
        const base = parsePeBigInt(m.baseAddress) ?? 0n;
        if (base === 0n) continue;
        try {
          const peData = await this.apiClient.getPe('0x' + base.toString(16));
          for (const s of (peData?.sections ?? [])) {
            const span = getPeSectionSpan(s, base);
            if (!span) continue;
            sections.push({
              start: span.start,
              end: span.endExclusive,
              perm: getPeSectionPermission(s.characteristics),
            });
          }
        } catch (err) {
          failures.push({ module: m?.name ?? '?', base: m?.baseAddress, err: err?.message ?? String(err) });
        }
      }
      if (failures.length && typeof console !== 'undefined') {
        console.warn(`[App] PE fetch failed for ${failures.length} module(s); ` +
          `page classification will miss them. First failure:`, failures[0]);
      }
      this._sectionPermissions = sections;
    }

    getSectionPermissionForAddress(addr) {
      const big = parsePeBigInt(addr);
      if (big == null) return '';
      for (const s of (this._sectionPermissions ?? [])) {
        if (big >= s.start && big < s.end) return s.perm || '';
      }
      return '';
    }

    isCodeAddress(addr) {
      return this.getSectionPermissionForAddress(addr).includes('x');
    }

    _attachSectionPermission(pageData, address) {
      if (!pageData || typeof pageData !== 'object') return pageData;
      const sectionPerm = this.getSectionPermissionForAddress(address);
      pageData.sectionPermission = sectionPerm || 'none';
      return pageData;
    }

    _renderTimelineModules() {
      const modules = this.state.modules ?? [];
      const barsEl = document.getElementById('hm-timeline-modules-bars');
      const metaEl = document.getElementById('hm-timeline-modules-meta');
      if (!barsEl) return;

      const MODULE_COLORS = [
        '#4ec9b0', '#dcdcaa', '#9cdcfe', '#ce9178', '#c586c0',
        '#4fc1ff', '#b5cea8', '#f44747',
      ];

      if (!modules.length) {
        barsEl.innerHTML = '<div class="hm-module-bars-empty">No modules loaded</div>';
        if (metaEl) metaEl.textContent = '';
        return;
      }

      if (metaEl) {
        const main = modules.find(m => m.isMain);
        const totalMB = modules.reduce((sum, m) => sum + (m.imageSize || 0), 0) / 1024 / 1024;
        metaEl.textContent = `${modules.length} loaded · ${totalMB.toFixed(1)} MB` + (main ? ` · main: ${this._esc(main.name || main.path || '?')}` : '');
      }

      const sorted = [...modules].sort((a, b) => {
        if (a.isMain) return 1;
        if (b.isMain) return -1;
        return (b.imageSize || 0) - (a.imageSize || 0);
      });

      const maxSize = Math.max(1, ...sorted.map(m => m.imageSize || 0));
      const colorById = {};

      barsEl.innerHTML = sorted.map((m, i) => {
        const id = m.id ?? m.baseAddress ?? i;
        const rawName = m.name || m.path || '?';
        const safeName = this._esc(rawName).trim();
        const initial = safeName.charAt(0).toUpperCase() || '?';
        const rest = safeName.slice(1);
        const sizeText = m.imageSize ? `${(m.imageSize / 1024 / 1024).toFixed(1)} MB` : '';
        return `<span class="hm-module-bar-wrap">
          <button class="hm-module-bar">
            <span class="hm-module-bar-label">
              <span class="hm-label-initial">${initial}</span><span class="hm-label-rest">${rest}</span>
            </span>
            <span class="hm-module-bar-size">${sizeText || '?'}</span>
            <svg class="hm-label-initial-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <text x="50" y="50" text-anchor="middle" dominant-baseline="central">${initial}</text>
            </svg>
          </button>
        </span>`;
      }).join('');

      this._layoutMosaic(barsEl, sorted, maxSize);

      barsEl.querySelectorAll('.hm-module-bar').forEach(btn => {
        btn.addEventListener('click', () => {
          const addr = btn.dataset.modAddr;
          if (addr) {
            this._openModuleInMemoryLayout(addr);
          } else {
            this.setActiveTab('memorylayout');
          }
        });
      });
    }

    _layoutMosaic(container, modules, maxSize) {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        requestAnimationFrame(() => this._layoutMosaic(container, modules, maxSize));
        return;
      }

      const MODULE_COLORS = [
        '#4ec9b0', '#dcdcaa', '#9cdcfe', '#ce9178', '#c586c0',
        '#4fc1ff', '#b5cea8', '#f44747',
      ];

      const colorById = {};
      const data = {
        children: modules.map((m, i) => {
          const id = m.id ?? m.baseAddress ?? i;
          if (!colorById[id]) colorById[id] = MODULE_COLORS[Object.keys(colorById).length % MODULE_COLORS.length];
          const addr = m.baseAddress != null ? '0x' + BigInt(m.baseAddress).toString(16).toUpperCase() : '';
          const sizeText = m.imageSize ? `${(m.imageSize / 1024 / 1024).toFixed(1)} MB` : '';
          return {
            name: m.name || m.path || '?',
            value: m.imageSize || 1,
            color: colorById[id],
            isMain: !!m.isMain,
            index: i,
            addr,
            sizeText,
            path: m.path || '',
          };
        }),
      };

      const root = hierarchy(data).sum(d => d.value).sort((a, b) => b.value - a.value);
      treemap()
        .tile(treemapSquarify)
        .size([rect.width, rect.height])
        .padding(1)
        (root);

      root.leaves().forEach(leaf => {
        const wrap = container.children[leaf.data.index];
        if (!wrap) return;
        const w = leaf.x1 - leaf.x0;
        const h = leaf.y1 - leaf.y0;
        wrap.style.left = leaf.x0 + 'px';
        wrap.style.top = leaf.y0 + 'px';
        wrap.style.width = w + 'px';
        wrap.style.height = h + 'px';
        const sizeMetric = Math.sqrt(w * h);
        const labelFs = Math.max(8, Math.min(18, Math.floor(sizeMetric / 3.5)));
        const sizeFs = Math.max(6, Math.min(13, Math.floor(sizeMetric / 5)));
        const initialFs = Math.max(14, Math.min(26, Math.floor(sizeMetric / 2.5)));
        wrap.style.setProperty('--tile-fs-label', labelFs + 'px');
        wrap.style.setProperty('--tile-fs-size', sizeFs + 'px');
        wrap.style.setProperty('--tile-fs-initial', initialFs + 'px');

        const btn = wrap.querySelector('.hm-module-bar');
        if (!btn) return;
        btn.style.background = leaf.data.color;
        btn.style.width = '100%';
        btn.style.height = '100%';
        if (!leaf.data.isMain) {
          btn.style.border = '1px solid rgba(255,255,255,0.08)';
        }
        if (leaf.data.isMain) btn.classList.add('hm-module-bar-main');

        btn.dataset.modName = leaf.data.name;
        btn.dataset.modAddr = leaf.data.addr;
        btn.dataset.modSize = leaf.data.sizeText;
        btn.dataset.modPath = leaf.data.path;

        btn.addEventListener('mouseenter', (e) => {
          let tip = document.getElementById('hm-module-tooltip');
          if (!tip) {
            tip = document.createElement('div');
            tip.id = 'hm-module-tooltip';
            tip.className = 'hm-tooltip';
            document.getElementById('app').appendChild(tip);
          }
          const d = btn.dataset;
          const lines = [d.modName];
          if (d.modAddr) lines.push(d.modAddr);
          if (d.modSize) lines.push(d.modSize);
          if (d.modPath) lines.push(d.modPath);
          tip.innerHTML = lines.map(l => `<div class="hm-tooltip-row">${this._esc(l)}</div>`).join('');
          tip.style.display = 'block';
          const r = btn.getBoundingClientRect();
          tip.style.left = r.left + 'px';
          tip.style.top = (r.bottom + 4) + 'px';
        });
        btn.addEventListener('mouseleave', () => {
          const tip = document.getElementById('hm-module-tooltip');
          if (tip) tip.style.display = 'none';
        });
      });
    }

    _esc(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    _toHex(value) {
      try {
        return BigInt(String(value ?? '0')).toString(16).toUpperCase();
      } catch {
        return '0';
      }
    }

    async _fetchMemoryLayout() {
      if (!this.memoryLayoutView) return;
      this.memoryLayoutView.setLoading(true);
      try {
        const data = await this.apiClient.getMemoryLayout();
        this.memoryLayoutView.setData(data);
      } catch (err) {
        this.memoryLayoutView.setError(`Failed to load memory layout: ${err.message}`);
        this.notificationBar?.show(`Memory layout: ${err.message}`, 'error');
      } finally {
        this.memoryLayoutView.setLoading(false);
      }
    }

    async _fetchMemoryLayoutPageContent(address) {
      const position = this.getCurrentTracePosition();
      const threadId = this.state.activeThreadId;
      return this.dataManager.fetchPage(
        Math.floor(this.state.currentTime),
        threadId,
        position,
        address,
      );
    }

    _openMemoryLayoutPageSvg(address) {
      this.setActiveTab('page');
      this._navigatePageSvg(this.toDisplayAddress(address));
    }

    _openModuleInPe(address) {
      const normalizedAddress = this.toDisplayAddress(address);
      this.state.selectedPeImageBase = normalizedAddress;
      this.setActiveTab('pe');
      // Record the PE navigation as a single step. The address is captured
      // so replay can restore both the tab and the selected module.
      this._recordUserAction('module-click',
        { address: normalizedAddress, target: 'pe' },
        `Module → ${normalizedAddress} (PE)`);
    }

    _openModuleInMemoryLayout(addrHex) {
      if (this.memoryLayoutView) {
        this.memoryLayoutView.focusModule(addrHex);
      }
      this.setActiveTab('memorylayout');
      this._recordUserAction('module-click',
        { address: addrHex }, `Module → ${addrHex}`);
    }

    _openMemAccessRange(startAddrHex, endAddrHex, mode = 'R', { record = true } = {}) {
      // Clamp to 4-byte max range
      try {
        const start = BigInt(startAddrHex);
        const end = BigInt(endAddrHex);
        if (end - start > 0x4n) {
          endAddrHex = '0x' + (start + 0x4n).toString(16);
        }
      } catch { /* keep original values if parse fails */ }

      this.setActiveTab('memaccess');
      this.apiClient.drainQueue();
      requestAnimationFrame(() => {
        this.memaccessView?.acceptPrefill(startAddrHex, endAddrHex, mode);
      });
      if (record) {
        this._recordUserAction('mem-access',
          { startAddr: startAddrHex, endAddr: endAddrHex, mode },
          `Mem-access ${mode} ${startAddrHex}–${endAddrHex}`);
      }
    }

    async _openPosition(major, minor, threadId) {
      this.setActiveTab('position');
      // Wait briefly for the tab switch to render the component
      await new Promise(r => requestAnimationFrame(r));
      this.positionView?.load(major, minor, threadId);
      this._recordUserAction('position-open',
        { major, minor, threadId },
        `Position → ${this._toHex(major)}:${this._toHex(minor)}`);
    }

    async _fetchThreads() {
      try {
        const response = await this.apiClient.getThreads();
        const threads = response.threads ?? [];
        this.state.threads = threads;
        this.state.activeThreadId = threads.length > 0 ? (threads[0].threadId ?? null) : null;
        if (this.timeline) {
          this.timeline.setThreads(threads);
          if (this.state.activeThreadId != null) {
            this.timeline.setActiveThreadId(this.state.activeThreadId);
          }
        }
        this.positionView?.setThreads(threads);
        this.homeView?.setThreads(threads, this.state.activeThreadId);
        this._renderTimelineThreadsMeta();
      } catch (err) {
        this.notificationBar.show(`Thread data unavailable: ${err.message}`, 'warning');
      }
    }

    _renderTimelineThreadsMeta() {
      const metaEl = document.getElementById('hm-timeline-threads-meta');
      if (!metaEl) return;
      const threads = this.state.threads ?? [];
      if (!threads.length) {
        metaEl.textContent = '';
        return;
      }
      const active = threads.find(t => t.threadId === this.state.activeThreadId) ?? threads[0];
      const sym = active?.procSymbol?.name ? this._esc(active.procSymbol.name).split('!').pop() : null;
      const tid = active?.threadId != null ? `TID ${active.threadId}` : null;
      const parts = [`${threads.length} thread${threads.length === 1 ? '' : 's'}`];
      if (tid) parts.push(tid);
      if (sym) parts.push(sym);
      metaEl.textContent = parts.join(' · ');
    }

    async _fetchThreadLifetimes() {
      try {
        const response = await this.apiClient.getLifetimeEvents();
        const events = response?.threadLifetimeEvents ?? [];
        this._threadLifetimes = new Map();
        for (const ev of events) {
          const tid = ev?.thread?.id;
          if (tid == null) continue;
          if (!this._threadLifetimes.has(tid)) {
            this._threadLifetimes.set(tid, {});
          }
          const entry = this._threadLifetimes.get(tid);
          if (ev.eventType === 'ThreadCreated') {
            entry.start = ev.position ?? null;
          } else if (ev.eventType === 'ThreadTerminated') {
            entry.end = ev.position ?? null;
          }
        }
      } catch {
        this._threadLifetimes = new Map();
      }
      this.positionView?.setThreadLifetimes(this._threadLifetimes);
      this.homeView?.setThreadLifetimes(this._threadLifetimes);
    }

    async _fetchEnvironment() {
      if (!this.environmentView) return;
      this.environmentView.setLoading(true);
      try {
        const data = await this.apiClient.getEnvironment();
        this.environmentView.setData(data);
      } catch (err) {
        this.environmentView.setError(`Failed to load environment: ${err.message}`);
        this.notificationBar?.show(`Environment: ${err.message}`, 'error');
      } finally {
        this.environmentView.setLoading(false);
      }
    }

    async _queryModel(expression, depth = 2) {
      return this.apiClient.queryModel(expression, { depth });
    }

    async _refreshModelHome() {
      if (!this.modelView) return;

      if (!this.state.traceInfo?.available) {
        this.modelView.setDisconnected();
        return;
      }

      this.modelView.setConnected();
      this.modelView.setLoading(true);
      try {
        const data = await this._queryModel('@$cursession', 2);
        this.modelView.setResult(data);
      } catch (err) {
        this.modelView.setError(`Failed to load model roots: ${err.message}`);
        this.notificationBar?.show(`Model: ${err.message}`, 'error');
      } finally {
        this.modelView.setLoading(false);
      }
    }

    async _fetchPe(imageBase = '') {
      if (!this.peView) return;

      if (!this.state.traceInfo?.available) {
        this.peView.setDisconnected();
        return;
      }

      this.peView.setLoading(true);
      try {
        const data = await this.apiClient.getPe(imageBase);
        this.peView.setData(data);
      } catch (err) {
        this.peView.setError(`Failed to load PE structure: ${err.message}`);
        this.notificationBar?.show(`PE: ${err.message}`, 'error');
      } finally {
        this.peView.setLoading(false);
      }
    }

    async _searchStrings(query, limit = 100) {
      return this.apiClient.searchStrings(query, limit);
    }

    async _searchMemAccess(params) {
      const { startAddr, endAddr, mode, timeStartPct, timeEndPct } = params;
      const timeoutMs = 300000;  // 5 min — backend should never cut off; percent range is the sole limiter
      try {
        this.apiClient.drainQueue();
        await this.apiClient.waitForIdle();
        return await this.apiClient.getMemAccess({
          startAddr, endAddr, mode,
          timeoutMs,
          timeStartPct, timeEndPct,
        });
      } catch (error) {
        this.notificationBar?.show(`Mem access query failed: ${error.message}`, 'error');
        throw error;
      }
    }

    async _fetchCallstacksAtPositions(positions, threadId) {
      // Fetch call stacks in parallel for multiple positions
      const results = await Promise.all(
        positions.map(async (pos) => {
          try {
            return await this.dataManager.fetchCallStack(0, threadId, pos);
          } catch {
            return null;
          }
        })
      );
      return results.filter(r => r !== null);
    }

    async _requestServerStop() {
      try {
        await this.apiClient.stopServer();
        this.notificationBar.show('Stop requested. Server is shutting down.', 'info');
      } catch (err) {
        this.notificationBar.show(`Failed to stop server: ${err.message}`, 'error');
      }
    }

  initializeComponents() {
    // Timeline component
    this.timeline = new Timeline(this.viewport.timelineLayer, this.viewport.visualizationWidth, this.viewport.timelineHeight);
    this.timeline.setTimeRange(0, this.state.maxTime);
    this.timeline.setEvents(this.state.events);
    if (this.state.timeBounds?.first?.major && this.state.timeBounds?.last?.major) {
      this.timeline.setMajorRange(
        this.state.timeBounds.first.major,
        this.state.timeBounds.last.major,
        this.state.timeBounds.first.minor,
        this.state.timeBounds.last.minor,
      );
    }
    if (this.state.threads.length > 0) {
      this.timeline.setThreads(this.state.threads);
      if (this.state.activeThreadId == null) {
        this.state.activeThreadId = this.state.threads[0].threadId ?? null;
      }
      if (this.state.activeThreadId != null) {
        this.timeline.setActiveThreadId(this.state.activeThreadId);
      }
    }
    this.timeline.onThreadSelect = (threadId) => {
      this.state.activeThreadId = threadId;
      this._renderTimelineThreadsMeta();
      this.handleTimeCommit(this.state.currentTime);
      this._recordUserAction('thread-select',
        { threadId }, `Thread → ${threadId}`);
    };
    this.timeline.onTimeChange = (time) => this.handleTimePreview(time);
    this.timeline.onTimeCommit = (time) => this.handleTimeCommit(time);
    this.timeline.onSyncedEventJump = (event) => this.openFunctionEventFromTimeline(event);

    // Memory view component
    this.memoryView = new MemoryView(
      this.viewport.memoryLayer,
      this.viewport.backgroundLayer,
      this.viewport.pointersLayer,
      this.viewport.visualizationWidth,
      this.viewport.visualizationHeight
    );
    this.memoryView.setMemoryData(this.state.memoryData);
    this.memoryView.onAddressSelect = (address) => this.handleAddressSelect(address);

    // Controls component (manages HTML UI)
    this.controls = new Controls();
    this.controls.onPlayPause = () => this.togglePlayback();
    this.controls.onStep = (direction) => this.stepTime(direction);
    this.controls.onZoom = (direction) => this.handleZoomControl(direction);
    this.controls.onViewToggle = (view, enabled) => this.handleViewToggle(view, enabled);
    this.controls.onReplayKey = (action) => {
      if (action === 'advance') this._player?.advance();
      else if (action === 'retreat') this._player?.retreat();
    };

      // Memory page view (text list in right dock)
      const pageContainer = document.getElementById('page-canvas');
      if (pageContainer) {
        this.memoryPageView = new MemoryPageView(pageContainer);
    }

    const commandContainer = document.getElementById('command-workspace');
    if (commandContainer) {
      this.commandConsole = new CommandConsole(commandContainer);
      this.commandConsole.onExecute = async (command) => {
        const result = await this.executeWindbgCommand(command);
        this._recordUserAction('command',
          { commandText: command }, `Command: ${command.substring(0, 60)}`);
        return result;
      };
    }

    const functionContainer = document.getElementById('function-workspace');
    if (functionContainer) {
      this.functionCallBrowser = new FunctionCallBrowser(functionContainer);
      this.functionCallBrowser.onSearch = async (target) => {
        const result = await this.searchFunctionCalls(target);
        this._recordUserAction('search',
          { searchQuery: target, category: 'function-calls' },
          `Function-call search: "${target}"`);
        return result;
      };
      this.functionCallBrowser.onEventSelect = (event) => this.jumpToFunctionCallEvent(event);
      this.functionCallBrowser.onJumpToEvent = (event) => this.jumpToFunctionCallEvent(event);
      this.functionCallBrowser.onSyncEvents = (events) => this.syncFunctionEventsToTimeline(events);
    }

    const memLayoutContainer = document.getElementById('memorylayout-workspace');
    if (memLayoutContainer) {
      this.memoryLayoutView = new MemoryLayoutView(memLayoutContainer);
      this.memoryLayoutView.onRefresh = () => this._fetchMemoryLayout();
      this.memoryLayoutView.onRequestPageContent = (address) => this._fetchMemoryLayoutPageContent(address);
      this.memoryLayoutView.onViewPageSvg = (address) => this._openMemoryLayoutPageSvg(address);
      this.memoryLayoutView.onViewInPe = ({ base }) => this._openModuleInPe(base);
      this.memoryLayoutView.onViewInMemAccess = ({ base, end, label }) =>
        this._openMemAccessRange(base, end, 'W');
      this.memoryLayoutView.onFetchModuleSections = (imageBase) =>
        this.apiClient.getPe(imageBase);
      this.memoryLayoutView.setDisconnected();
    }

    const environmentContainer = document.getElementById('environment-workspace');
    if (environmentContainer) {
      this.environmentView = new EnvironmentView(environmentContainer);
      this.environmentView.onRefresh = () => this._fetchEnvironment();
      this.environmentView.onRequestPageContent = (address) => this._fetchMemoryLayoutPageContent(address);
      this.environmentView.setDisconnected();
    }

    const modelContainer = document.getElementById('model-workspace');
    if (modelContainer) {
      this.modelView = new ModelView(modelContainer);
      this.modelView.onRefresh = () => this._refreshModelHome();
      this.modelView.onExecute = async ({ expression, depth }) => this._queryModel(expression, depth);
      this.modelView.setDisconnected();
    }

    const peContainer = document.getElementById('pe-workspace');
    if (peContainer) {
      this.peView = new PeView(peContainer);
      this.peView.onRefresh = () => this._fetchPe(this.state.selectedPeImageBase || '');
      this.peView.setDisconnected();
    }

    const stringsContainer = document.getElementById('strings-workspace');
    if (stringsContainer) {
      this.stringsView = new StringsView(stringsContainer);
      this.stringsView.onSearch = async ({ query, limit }) => {
        const result = await this._searchStrings(query, limit);
        this._recordUserAction('search',
          { searchQuery: query, category: 'strings' },
          `String search: "${query}"`);
        return result;
      };
      this.stringsView.onViewSvg = (address) => this._openMemoryLayoutPageSvg(address);
      this.stringsView.setDisconnected();
    }

    const memaccessContainer = document.getElementById('memaccess-workspace');
    if (memaccessContainer) {
      this.memaccessView = new MemAccessView(memaccessContainer);
      this.memaccessView.onSearch = async (params) => {
        const result = await this._searchMemAccess(params);
        this._recordUserAction('mem-access',
          {
            startAddr: params.startAddr,
            endAddr: params.endAddr,
            mode: params.mode,
            timeStartPct: params.timeStartPct,
            timeEndPct: params.timeEndPct,
          },
          `Mem-access ${params.mode} ${params.startAddr}–${params.endAddr} [${params.timeStartPct}–${params.timeEndPct}%]`);
        return result;
      };
      this.memaccessView.onClickPosition = (major, minor, threadId) =>
        this._openPosition(major, minor, threadId);
      this.memaccessView.setDisconnected();
    }

    const flamegraphContainer = document.getElementById('flamegraph-workspace');
    if (flamegraphContainer) {
      this.flamegraphView = new FlameGraphView(flamegraphContainer);
      this.flamegraphView.onGetTraceBounds = () => this.state.timeBounds;
      this.flamegraphView.onGetThreads = () => this.state.threads;
          this.flamegraphView.onGetThreadLifetimes = () => this._threadLifetimes;
          this.positionView?.setThreadLifetimes(this._threadLifetimes);
      this.homeView?.setThreadLifetimes(this._threadLifetimes);
      this.flamegraphView.onGetActiveThreadId = () => this.state.activeThreadId;
      this.flamegraphView.onFetchCallstacks = async ({ positions, threadId }) =>
        this._fetchCallstacksAtPositions(positions, threadId);
      this.flamegraphView.onClickFrame = (start, end, mode) => {
        this._recordUserAction('flamegraph',
          { start, end, mode },
          'Flame Graph');
        this._openMemAccessRange(start, end, mode, { record: false });
      };
      this.flamegraphView.onFetchAllThreadFrames =
        async (threadId) => this._isReplayMode()
          ? this._getRecordedCallstackFramesForThread(threadId)
          : [];
      this.flamegraphView.setDisconnected();
    }

    const queueContainer = document.getElementById('queue-workspace');
    if (queueContainer) {
      this.queueView = new QueueView(queueContainer);
      this.queueView.onGetState = () => this.apiClient.dumpQueueState();
      this.queueView.onExport = () => this._exportStoryline();
      this.queueView.onLoadStoryline = (archive, filename) => {
        if (filename) this._enterReplayModeFromFile(archive, filename);
        else this.loadStorylineArchive(archive);
      };
      this.queueView.setDisconnected();
    }

    const positionContainer = document.getElementById('position-workspace');
    if (positionContainer) {
      this.positionView = new PositionView(positionContainer);
      this.positionView.onFetchCallstack = async ({ major, minor, threadId }) => {
        const data = await this.dataManager.fetchCallStack(0, threadId,
          { major: String(major), minor: Number(minor) });
        return data?.frames ?? [];
      };
      this.positionView.onFetchRegisters = async ({ major, minor, threadId }) => {
        const data = await this.dataManager.fetchRegisters(0, threadId,
          { major: String(major), minor: Number(minor) });
        return data?.registers ?? {};
      };
      this.positionView.onFetchPageRender = async ({ major, minor, threadId, address }) => {
        const sectionPermission = this.getSectionPermissionForAddress(address);
        const isCode = sectionPermission.includes('x');
        const fn = isCode ? this.apiClient.getPageRenderCode : this.apiClient.getPageRenderData;
        const data = this._attachSectionPermission(await fn.call(this.apiClient, {
          major: String(major), minor: Number(minor),
          threadId, address: String(address),
        }), address);
        return { data, isCode, sectionPermission: sectionPermission || 'none' };
      };
      this.positionView.onCheckExecutable = (pageAddr) => {
        return this.isCodeAddress(pageAddr);
      };
      this.positionView.setThreads(this.state.threads);
      this.positionView.setTraceBounds(this.state.timeBounds);
      this.positionView.setThreadLifetimes(this._threadLifetimes);
      this.positionView.setDisconnected();
    }

    const homeContainer = document.getElementById('home-workspace');
    if (homeContainer) {
      this.homeView = new HomeView(homeContainer);
      this.homeView.onNavigate = (tab) => this.setActiveTab(tab);
      this.homeView.setDisconnected();
    }

    const pageSvgContainer = document.getElementById('pagesvg-workspace');
    if (pageSvgContainer) {
      this.pageSvgView = new MemoryPageSvgView(pageSvgContainer);
      this.pageSvgView.onNavigate = (address) => this._navigatePageSvg(address);
      this.pageSvgView.onClickAnnotationAddr = (address) => this._navigatePageSvg(address);
      this.pageSvgView.onCheckExecutable = (pageAddr) => {
        return this.isCodeAddress(pageAddr);
      };
      this.pageSvgView.setDisconnected();
    }

    const svgBtn = document.getElementById('btn-page-svg');
    if (svgBtn) svgBtn.addEventListener('click', () => this.setActiveTab('page'));

    // Update controls with initial state
    this.updateControls();
  }

  setupControls() {
    // Update info panel
    this.updateInfoPanel();
  }

  setupTabs() {
    const appRoot = document.getElementById('app');
    const tabButtons = document.querySelectorAll('[data-tab-target]');

    // Disable all tabs except Home until data is loaded
    this._tabsReady = false;
    tabButtons.forEach((button) => {
      if (button.dataset.tabTarget !== 'timeline') {
        button.disabled = true;
      }
      button.addEventListener('click', () => {
        if (button.disabled) return;
        const target = button.dataset.tabTarget;
        this.setActiveTab(target);
        this._recordUserAction('tab-switch',
          { tabTarget: target }, `Tab → "${target}"`);
      });
    });

    if (appRoot) {
      appRoot.dataset.activeTab = this.state.activeTab;
    }

    this.setActiveTab(this.state.activeTab);
  }

  setActiveTab(tabName) {
    const validTabs = ['home', 'timeline', 'command', 'function', 'page', 'memorylayout', 'environment', 'model', 'pe', 'strings', 'memaccess', 'flamegraph', 'queue', 'position'];
    const nextTab = validTabs.includes(tabName) ? (tabName === 'home' ? 'timeline' : tabName) : 'timeline';
    this.state.activeTab = nextTab;

    // Cancel in-flight requests when switching away from flamegraph to avoid
    // deadlocking the single-threaded dk server (e.g. callstacks vs mem-access)
    if (nextTab !== 'flamegraph') {
      this.apiClient.drainQueue();
    }

    const appRoot = document.getElementById('app');
    if (appRoot) {
      appRoot.dataset.activeTab = nextTab;
    }

    document.querySelectorAll('[data-tab-target]').forEach((button) => {
      const isActive = button.dataset.tabTarget === nextTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    this.commandConsole?.setActive(nextTab === 'command');
    this.functionCallBrowser?.setActive(nextTab === 'function');
    this.timeline?.setActive(nextTab === 'timeline');
    this.memoryLayoutView?.setActive(nextTab === 'memorylayout');
    this.environmentView?.setActive(nextTab === 'environment');
    this.modelView?.setActive(nextTab === 'model');
    this.peView?.setActive(nextTab === 'pe');
    this.stringsView?.setActive(nextTab === 'strings');
    this.memaccessView?.setActive(nextTab === 'memaccess');
    this.flamegraphView?.setActive(nextTab === 'flamegraph');
    this.queueView?.setActive(nextTab === 'queue');
    this.positionView?.setActive(nextTab === 'position');
    this.pageSvgView?.setActive(nextTab === 'page');

    if (nextTab === 'page') {
      this._loadPageSvgView();
    }
    if (nextTab === 'timeline') {
      if (this.timeline) {
        const innerH = window.innerHeight;
        const offset = Math.max(0, innerH * 0.5 - 18 + 32);
        this.timeline.setThreadsTopOffset(offset);
      }
    }
    if (nextTab === 'memorylayout') {
      this._fetchMemoryLayout();
    }
    if (nextTab === 'environment') {
      this._fetchEnvironment();
    }
    if (nextTab === 'model') {
      this._refreshModelHome();
    }
    if (nextTab === 'pe') {
      this._fetchPe(this.state.selectedPeImageBase || '');
    }
  }

  setupAnimationLoop() {
    // Main update loop
    this.pixiApp.ticker.add(() => {
      if (this.state.isPlaying) {
        this.updatePlayback();
      }

      // Update components
      if (this.timeline) {
        this.timeline.update();
      }
    });
  }

  updatePlayback() {
    const deltaTime = this.pixiApp.ticker.deltaMS;
    const timeIncrement = (deltaTime / 1000) * this.state.playbackSpeed * 100;

    this.state.currentTime += timeIncrement;

    if (this.state.currentTime >= this.state.maxTime) {
      this.state.currentTime = this.state.maxTime;
      this.pausePlayback();
    }

    this.timeline.setTime(this.state.currentTime);
    this.state.currentTime = this.timeline.currentTime;
    this.state.currentPosition = this.getCurrentTracePosition();
    this.updateMemoryAtTime(this.state.currentTime);
    this.updateRegistersAtTime(this.state.currentTime);
    this.updateInfoPanel();
  }

  togglePlayback() {
    if (this.state.isPlaying) {
      this.pausePlayback();
    } else {
      this.startPlayback();
    }
  }

  startPlayback() {
    this.state.isPlaying = true;
    this.controls.setPlaying(true);
  }

  pausePlayback() {
    this.state.isPlaying = false;
    this.controls.setPlaying(false);
  }

  stepTime(direction) {
    const stepSize = 10;
    this.state.currentTime = Math.max(0, Math.min(this.state.maxTime,
      this.state.currentTime + (direction * stepSize)));
    this.handleTimeCommit(this.state.currentTime);
  }

  handleTimePreview(time, positionOverride = null) {
    this.timeline.setTime(time);
    this.state.currentTime = this.timeline.currentTime;
    this.state.currentPosition = this.getCurrentTracePosition(positionOverride);
    this.updateMemoryAtTime(this.state.currentTime);
    this.updateInfoPanel();
  }

  handleTimeCommit(time, positionOverride = null) {
    this.handleTimePreview(time, positionOverride);
    this.updateRegistersAtTime(this.state.currentTime, positionOverride);
    this.updateCallstackAtTime(this.state.currentTime, positionOverride);
    this.updatePageAtTime(this.state.currentTime, positionOverride);
    // Timeline seek is no longer recorded as its own step. The seek's
    // API responses (registers, callstack, page render) are absorbed into
    // the recording buffer and become part of the next user action's step.
  }

  getCurrentTracePosition(positionOverride = null) {
    if (positionOverride?.major != null) {
      const major = String(positionOverride.major);
      const minor = Number(positionOverride.minor ?? 0);
      return {
        major,
        minor: Number.isFinite(minor) ? Math.max(0, Math.floor(minor)) : 0,
      };
    }

    if (!this.state.timeBounds?.first?.major || !this.state.timeBounds?.last?.major) {
      return null;
    }

    try {
      const startMajor = BigInt(this.state.timeBounds.first.major);
      const endMajor = BigInt(this.state.timeBounds.last.major);
      const startMinor = Number(this.state.timeBounds.first.minor ?? 0);
      const endMinor = Number(this.state.timeBounds.last.minor ?? 0);
      const normalized = this.state.maxTime > 0
        ? Math.max(0, Math.min(1, this.state.currentTime / this.state.maxTime))
        : 0;
      const scaled = BigInt(Math.round(normalized * 1000000));

      const major = endMajor > startMajor
        ? startMajor + ((endMajor - startMajor) * scaled) / 1000000n
        : startMajor;
      const minor = Math.max(0, Math.round(startMinor + (endMinor - startMinor) * normalized));

      return {
        major: major.toString(),
        minor,
      };
    } catch {
      return null;
    }
  }

  async updatePageAtTime(time, positionOverride = null) {
    if (!this.state.traceInfo?.available || !this.memoryPageView) return;
    try {
      const position = this.getCurrentTracePosition(positionOverride);
      const major = position?.major;
      const minor = position?.minor;
      // Classification must always use a real memory address — not a trace
      // position coordinate.  The backend renders the page at RSP, so use the
      // latest RSP value to decide code vs. data.  If RSP is not yet available
      // (first frame) default to data.
      const rsp = String(this.latestRegisters?.rsp ?? '').trim();
      const sectionPermission = rsp ? this.getSectionPermissionForAddress(rsp) : '';
      const isCode = sectionPermission.includes('x');
      const fn = isCode ? this.apiClient.getPageRenderCode : this.apiClient.getPageRenderData;
      const data = this._attachSectionPermission(await fn.call(this.apiClient, {
        major, minor,
        threadId: this.state.activeThreadId,
      }), rsp);
      this.memoryPageView.setData(data, isCode);
      const debugEl = document.getElementById('page-debug-meta');
      if (debugEl) debugEl.textContent = `PE perm: ${data?.sectionPermission || 'none'}`;
    } catch {
      // page route may not be available on all backends
    }
  }

  async openPageSvg() {
    if (!this.state.traceInfo?.available) return;
    try {
      const requestedAddress = this.resolvePageRequestAddress('');
      const position = this.getCurrentTracePosition();
      const dark = this.getPageSvgTheme() === 'dark';
      const svgText = await this.apiClient.getPageSvg({
        major: position?.major,
        minor: position?.minor,
        threadId: this.state.activeThreadId,
        address: requestedAddress || undefined,
        dark,
      });
      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const blobUrl = URL.createObjectURL(blob);
      window.open(blobUrl, '_blank');
    } catch (err) {
      this.notificationBar?.show(`Failed to open SVG: ${err.message}`, 'error');
    }
  }

  async _loadPageSvgView() {
    if (!this.pageSvgView || !this.state.traceInfo?.available) return;
    try {
      const position = this.getCurrentTracePosition();
      const requestedAddress = this.resolvePageRequestAddress('');
      // requestedAddress is already a real memory address (RSP or selected
      // address) — feed it directly to the central classifier.  Without an
      // address (empty RSP, no selection) default to data.
      const sectionPermission = requestedAddress ? this.getSectionPermissionForAddress(requestedAddress) : '';
      const isCode = sectionPermission.includes('x');
      const fn = isCode ? this.apiClient.getPageRenderCode : this.apiClient.getPageRenderData;
      const data = this._attachSectionPermission(await fn.call(this.apiClient, {
        major: position?.major,
        minor: position?.minor,
        threadId: this.state.activeThreadId,
        address: requestedAddress || undefined,
      }), requestedAddress);
      this.pageSvgView.setData(data, isCode);
    } catch (err) {
      this.notificationBar?.show(`Page render: ${err.message}`, 'error');
    }
  }

  async _navigatePageSvg(address) {
    if (!this.pageSvgView) return;
    try {
      const position = this.getCurrentTracePosition();
      const sectionPermission = this.getSectionPermissionForAddress(address);
      const isCode = sectionPermission.includes('x');
      const fn = isCode ? this.apiClient.getPageRenderCode : this.apiClient.getPageRenderData;
      const data = this._attachSectionPermission(await fn.call(this.apiClient, {
        major: position?.major,
        minor: position?.minor,
        threadId: this.state.activeThreadId,
        address,
      }), address);
      this.pageSvgView.setData(data, isCode);
    } catch (err) {
      this.notificationBar?.show(`Page render: ${err.message}`, 'error');
    }
    this._recordUserAction('page-navigate',
      { address }, `Page → ${this.toDisplayAddress(address)}`);
  }

  getPageSvgTheme() {
    return this.pageSvgView?._theme ?? 'dark';
  }

  isTypingTarget(target) {
    if (!target || typeof target !== 'object') return false;
    const tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  parseAddress(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    try {
      return BigInt(raw);
    } catch {
      return null;
    }
  }

  formatAddress(value) {
    if (typeof value !== 'bigint') return '';
    return `0x${value.toString(16)}`;
  }

  resolvePageRequestAddress(rawInput) {
    const typed = String(rawInput ?? '').trim();
    if (typed) return typed;

    const rsp = String(this.latestRegisters?.rsp ?? '').trim();
    if (rsp) return rsp;

    const selected = String(this.state.selectedAddress ?? '').trim();
    if (selected) return selected;

    return '';
  }

  toDisplayAddress(value) {
    const parsed = this.parseAddress(value);
    if (parsed != null) {
      return this.formatAddress(parsed);
    }
    return '0x0';
  }

  async updateRegistersAtTime(time, positionOverride = null) {
    if (!this.state.traceInfo?.available) {
      return;
    }

    try {
      const position = this.getCurrentTracePosition(positionOverride);
      const regs = await this.dataManager.fetchRegisters(
        Math.floor(time),
        this.state.activeThreadId,
        position,
      );
      this.updateRegistersPanel(regs?.registers);
    } catch {
      // Register route lands in a later phase on some backends.
    }
  }

  updateRegistersPanel(registers) {
    this.latestRegisters = registers ?? null;

    const map = [
      ['rax', 'reg-rax'],
      ['rbx', 'reg-rbx'],
      ['rcx', 'reg-rcx'],
      ['rdx', 'reg-rdx'],
      ['rsi', 'reg-rsi'],
      ['rdi', 'reg-rdi'],
      ['rbp', 'reg-rbp'],
      ['rsp', 'reg-rsp'],
      ['rip', 'reg-rip'],
      ['r8',  'reg-r8'],
      ['r9',  'reg-r9'],
      ['r10', 'reg-r10'],
      ['r11', 'reg-r11'],
      ['r12', 'reg-r12'],
      ['r13', 'reg-r13'],
      ['r14', 'reg-r14'],
      ['r15', 'reg-r15'],
    ];

    map.forEach(([key, id]) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = registers?.[key] ?? '--';
    });

    this.updateInfoPanel();
  }

  async updateMemoryAtTime(time) {
    // Find events at this time
    const eventsAtTime = this.state.events.filter(e =>
      Math.abs(e.time - time) < 10
    );

    // Update memory view with events
    if (this.memoryView) {
      this.memoryView.highlightEvents(eventsAtTime);
    }
  }

  async updateCallstackAtTime(time, positionOverride = null) {
    // /api/callstack is a later-phase route; avoid probe calls in Phase 1.
    if (!this.state.traceInfo?.available) {
      return;
    }

    try {
      const position = this.getCurrentTracePosition(positionOverride);
      const callStackData = await this.dataManager.fetchCallStack(
        time,
        this.state.activeThreadId,
        position,
      );
      this.updateCallstackPanel(callStackData.frames);
    } catch (error) {
      console.error('Failed to update callstack:', error);
    }
  }

  updateCallstackPanel(frames) {
    const el = document.getElementById('callstack-content');
    if (!el) return;

    if (!frames || frames.length === 0) {
      el.innerHTML = '<span class="cs-empty">—</span>';
      return;
    }

    el.innerHTML = frames.map(f => {
      const num  = String(f.frameNumber ?? '').padStart(2, '0');
      const addr = f.instructionOffset
        ? '0x' + BigInt(f.instructionOffset).toString(16).padStart(12, '0')
        : '?';
      const sym  = f.function || '';
      const disp = (f.displacement && f.displacement !== 0)
        ? `+0x${f.displacement.toString(16)}`
        : '';
      return `<div class="cs-frame">
        <span class="cs-num">#${num}</span>
        <span class="cs-addr">${addr}</span>
        <span class="cs-sym">${sym}</span>
        ${disp ? `<span class="cs-disp">${disp}</span>` : ''}
      </div>`;
    }).join('');
  }

  handleAddressSelect(address) {
    this.state.selectedAddress = address;
    this.updateInfoPanel();
    this.controls.updateHexDump(address, this.state.memoryData);
    this._recordUserAction('address-click',
      { address }, `Address → ${this.toDisplayAddress(address)}`);
  }

  handleZoomControl(direction) {
    if (direction === 'in') {
      this.viewport.zoom(1.5, this.viewport.width / 2, this.viewport.height / 2);
      this.state.zoomLevel = Math.min(MAX_ZOOM_LEVEL, this.state.zoomLevel + 1);
    } else if (direction === 'out') {
      this.viewport.zoom(0.67, this.viewport.width / 2, this.viewport.height / 2);
      this.state.zoomLevel = Math.max(MIN_ZOOM_LEVEL, this.state.zoomLevel - 1);
    } else if (direction === 'reset') {
      this.viewport.resetCamera();
      this.state.zoomLevel = MIN_ZOOM_LEVEL;
    }

    this.updateInfoPanel();
  }

  handleViewToggle(view, enabled) {
    switch (view) {
      case 'heatmap':
        if (this.memoryView) {
          this.memoryView.toggleHeatmap(enabled);
        }
        break;
      case 'regions':
        if (this.memoryView) {
          this.memoryView.toggleRegions(enabled);
        }
        break;
      case 'pointers':
        if (this.memoryView) {
          this.memoryView.togglePointers(enabled);
        }
        break;
      case 'hex':
        this.controls.toggleHexDump(enabled);
        break;
    }
  }

  updateControls() {
    this.controls.setPlaying(this.state.isPlaying);
  }

  async executeWindbgCommand(command) {
    try {
      return await this.apiClient.executeWindbgCommand(command);
    } catch (error) {
      this.notificationBar?.show(`Command failed: ${error.message}`, 'error');
      throw error;
    }
  }

  async searchFunctionCalls(target) {
    try {
      return await this.apiClient.searchFunctionCalls(target);
    } catch (error) {
      this.notificationBar?.show(`Function-call search failed: ${error.message}`, 'error');
      throw error;
    }
  }

  jumpToFunctionCallEvent(event) {
    const normalizedTime = this.positionToTimelineTime(event?.startPosition);
    const threadId = Number(event?.threadId);

    if (Number.isFinite(threadId) && this.timeline?.setActiveThreadId(threadId)) {
      this.state.activeThreadId = threadId;
      this._renderTimelineThreadsMeta();
    }

    if (normalizedTime != null) {
      this.handleTimeCommit(normalizedTime, event?.startPosition ?? null);
    }
  }

  syncFunctionEventsToTimeline(events) {
    const syncedEvents = Array.isArray(events) ? events : [];
    this.state.events = syncedEvents;
    this.timeline?.setEvents(syncedEvents);
    this.setActiveTab('timeline');
  }

  openFunctionEventFromTimeline(event) {
    if (!event?.eventId) return;
    this.setActiveTab('function');
    const focused = this.functionCallBrowser?.focusEventById(event.eventId);
    if (!focused) {
      this.notificationBar?.show('Event is not in current function-call result set.', 'warning');
    }
  }

  positionToTimelineTime(position) {
    if (!position?.major || !this.state.timeBounds?.first?.major || !this.state.timeBounds?.last?.major) {
      return null;
    }

    try {
      const startMajor = BigInt(this.state.timeBounds.first.major);
      const endMajor = BigInt(this.state.timeBounds.last.major);
      const posMajor = BigInt(position.major);
      const startMinor = BigInt(this.state.timeBounds.first.minor ?? 0);
      const endMinor = BigInt(this.state.timeBounds.last.minor ?? 0);
      const posMinor = BigInt(position.minor ?? 0);
      const scale = 1000000n;

      const majorSpan = endMajor - startMajor;
      if (majorSpan > 0n) {
        const clampedMajor = posMajor < startMajor ? startMajor : (posMajor > endMajor ? endMajor : posMajor);
        const scaled = ((clampedMajor - startMajor) * scale) / majorSpan;
        return (Number(scaled) / 1000000) * this.state.maxTime;
      }

      const minorSpan = endMinor - startMinor;
      if (minorSpan > 0n) {
        const clampedMinor = posMinor < startMinor ? startMinor : (posMinor > endMinor ? endMinor : posMinor);
        const scaled = ((clampedMinor - startMinor) * scale) / minorSpan;
        return (Number(scaled) / 1000000) * this.state.maxTime;
      }
    } catch {
      return null;
    }

    return null;
  }

  updateInfoPanel() {
    const positionEl = document.getElementById('info-position');
    const threadEl = document.getElementById('info-thread');
    const pcEl = document.getElementById('info-pc');
    const spEl = document.getElementById('info-sp');

    if (positionEl) {
      const pos = this.state.currentPosition;
      if (pos?.major != null) {
        const minor = Number.isFinite(Number(pos.minor)) ? Number(pos.minor) : 0;
        const majHex = BigInt(pos.major).toString(16).toUpperCase();
        const minHex = minor.toString(16).toUpperCase();
        positionEl.textContent = `${majHex}:${minHex}`;
      } else {
        positionEl.textContent = '--:--';
      }
    }

    if (threadEl) {
      threadEl.textContent = this.state.activeThreadId != null ? String(this.state.activeThreadId) : '--';
    }

    if (pcEl) {
      pcEl.textContent = this.latestRegisters?.rip ?? '--';
    }

    if (spEl) {
      spEl.textContent = this.latestRegisters?.rsp ?? '--';
    }
  }

  _exportStoryline() {
    if (!this._recorder) return;
    const archive = this._recorder.downloadArchive(
      this.state.traceInfo,
      this._recorder._name,
    );
    this.notificationBar.show(
      `Storyline exported: ${archive.stepCount} steps, ${archive.requestCount} requests`,
      'info',
    );
  }

  _enterReplayModeFromFile(archive, filename) {
    const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
    const target = `${base}/replay/${encodeURIComponent(filename)}`;
    if (window.location.pathname !== target) {
      window.history.replaceState(null, '', target);
    }
    this.loadStorylineArchive(archive);
  }

  handleResize() {
    this.viewport.resize(this.pixiApp.screen.width, this.pixiApp.screen.height);

    if (this.timeline) {
      this.timeline.resize(this.viewport.visualizationWidth, this.viewport.timelineHeight);
    }

    if (this.memoryView) {
      this.memoryView.resize(this.viewport.visualizationWidth, this.viewport.visualizationHeight);
    }

    // MemoryPageView auto-resizes via its internal ResizeObserver
  }
}
