import DataManager from './DataManager.js';
import Viewport from './Viewport.js';
import Timeline from '../components/Timeline.js';
import MemoryView from '../components/MemoryView.js';
import MemoryPageView from '../components/MemoryPageView.js';
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
import MemoryPageSvgView from '../components/MemoryPageSvgView.js';

const TIMELINE_HEIGHT = 220; // fallback only; actual height from viewport.timelineHeight

/**
 * App - Main application controller
 * Coordinates all components and manages application state
 */
export default class App {
  constructor(pixiApp) {
    this.pixiApp = pixiApp;
    // API layer must be created before DataManager so callstack requests
    // flow through the shared request queue
    this.apiClient = new ApiClient();
    this.connectionMonitor = new ConnectionMonitor(this.apiClient);
    this.dataManager = new DataManager(this.apiClient);
    this.viewport = new Viewport(pixiApp);

    // Application state
    this.state = {
      currentTime: 0,
      maxTime: 10000,
      currentPosition: null,
      isPlaying: false,
      playbackSpeed: 1,
      zoomLevel: 0,
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
    this.positionView = null;
    this._threadLifetimes = new Map(); // threadId → { start, end }
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

      this.connectionMonitor.onStateChange = (connected, serverData) =>
        this._handleConnectionChange(connected, serverData);
      this.connectionMonitor.onStatusUpdate = (statusResponse) =>
        this._handleStatusUpdate(statusResponse);
      this.connectionMonitor.start();

      // Load scaffold data (falls back to mock until Phase 2-5 routes are live)
      await this.loadInitialData();

    // Initialize components
    this.initializeComponents();

    // Setup UI controls
    this.setupControls();
    this.setupTabs();

    // Setup animation loop
    this.setupAnimationLoop();

    console.log('Application initialized');
  }

  async loadInitialData() {
    // Visualization data populated from live backend once connected.
    this.state.memoryData = null;
    this.state.events = [];
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
        this.positionView?.setDisconnected();
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
          this.timeline.setModules([]);
          this.timeline.setThreads([]);
        }
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
        }
      } catch (err) {
        // Server is up but trace-info failed — show partial status
        this.connectionPanel.setConnected(serverData?.server, null);
        this.notificationBar.show(`Trace info unavailable: ${err.message}`, 'error');
      }

      // Phase 2: fetch module lanes regardless of trace-info outcome
      this._fetchModules();
      this._fetchThreads();
      this._fetchThreadLifetimes();
      this._fetchMemoryLayout();
      this._fetchEnvironment();
      this._refreshModelHome();
      this._fetchPe();
    }

    async _fetchModules() {
      try {
        const response = await this.apiClient.getModules();
        const modules = response.modules ?? [];
        this.state.modules = modules;
        if (this.timeline) {
          this.timeline.setModules(modules);
        }
      } catch (err) {
        this.notificationBar.show(`Module data unavailable: ${err.message}`, 'warning');
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
    }

    _openMemAccessRange(startAddrHex, endAddrHex, mode = 'R') {
      // Clamp to 32-byte max range
      try {
        const start = BigInt(startAddrHex);
        const end = BigInt(endAddrHex);
        if (end - start > 0x20n) {
          endAddrHex = '0x' + (start + 0x20n).toString(16);
        }
      } catch { /* keep original values if parse fails */ }

      this.setActiveTab('memaccess');
      this.apiClient.drainQueue();
      requestAnimationFrame(() => {
        this.memaccessView?.acceptPrefill(startAddrHex, endAddrHex, mode);
      });
    }

    async _openPosition(major, minor, threadId) {
      this.setActiveTab('position');
      // Wait briefly for the tab switch to render the component
      await new Promise(r => requestAnimationFrame(r));
      this.positionView?.load(major, minor, threadId);
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
      } catch (err) {
        this.notificationBar.show(`Thread data unavailable: ${err.message}`, 'warning');
      }
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
    if (this.state.modules.length > 0) {
      this.timeline.setModules(this.state.modules);
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
      this.handleTimeCommit(this.state.currentTime);
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

      // Memory page view (DOM text panel in right dock)
      const pageContainer = document.getElementById('page-canvas');
      if (pageContainer) {
        this.memoryPageView = new MemoryPageView(pageContainer);
    }

    const commandContainer = document.getElementById('command-workspace');
    if (commandContainer) {
      this.commandConsole = new CommandConsole(commandContainer);
      this.commandConsole.onExecute = (command) => this.executeWindbgCommand(command);
    }

    const functionContainer = document.getElementById('function-workspace');
    if (functionContainer) {
      this.functionCallBrowser = new FunctionCallBrowser(functionContainer);
      this.functionCallBrowser.onSearch = (target) => this.searchFunctionCalls(target);
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
      this.stringsView.onSearch = async ({ query, limit }) => this._searchStrings(query, limit);
      this.stringsView.onViewSvg = (address) => this._openMemoryLayoutPageSvg(address);
      this.stringsView.setDisconnected();
    }

    const memaccessContainer = document.getElementById('memaccess-workspace');
    if (memaccessContainer) {
      this.memaccessView = new MemAccessView(memaccessContainer);
      this.memaccessView.onSearch = async (params) =>
        this._searchMemAccess(params);
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
      this.flamegraphView.onGetActiveThreadId = () => this.state.activeThreadId;
      this.flamegraphView.onFetchCallstacks = async ({ positions, threadId }) =>
        this._fetchCallstacksAtPositions(positions, threadId);
      this.flamegraphView.onClickFrame = (start, end, mode) =>
        this._openMemAccessRange(start, end, mode);
      this.flamegraphView.setDisconnected();
    }

    const queueContainer = document.getElementById('queue-workspace');
    if (queueContainer) {
      this.queueView = new QueueView(queueContainer);
      this.queueView.onGetState = () => this.apiClient.dumpQueueState();
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
      this.positionView.onFetchStackSvg = async ({ major, minor, threadId, rsp }) => {
        const dark = this.getPageSvgTheme() === 'dark';
        return await this.apiClient.getPageSvg({
          major: String(major), minor: Number(minor),
          threadId, address: String(rsp), dark,
        });
      };
      this.positionView.setDisconnected();
    }

    const pageSvgContainer = document.getElementById('pagesvg-workspace');
    if (pageSvgContainer) {
      this.pageSvgView = new MemoryPageSvgView(pageSvgContainer);
      this.pageSvgView.onNavigate = (address) => this._navigatePageSvg(address);
      this.pageSvgView.onClickAnnotationAddr = (address) => this._navigatePageSvg(address);
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

    tabButtons.forEach((button) => {
      button.addEventListener('click', () => {
        this.setActiveTab(button.dataset.tabTarget);
      });
    });

    if (appRoot) {
      appRoot.dataset.activeTab = this.state.activeTab;
    }

    this.setActiveTab(this.state.activeTab);
  }

  setActiveTab(tabName) {
    const validTabs = ['timeline', 'command', 'function', 'page', 'memorylayout', 'environment', 'model', 'pe', 'strings', 'memaccess', 'flamegraph', 'queue', 'position'];
    const nextTab = validTabs.includes(tabName) ? tabName : 'timeline';
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
      const pageData = await this.dataManager.fetchPage(
        Math.floor(time),
        this.state.activeThreadId,
        position,
      );
      this.memoryPageView.setData(pageData);
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
      const data = await this.apiClient.getPageRender({
        major: position?.major,
        minor: position?.minor,
        threadId: this.state.activeThreadId,
        address: requestedAddress || undefined,
      });
      this.pageSvgView.setData(data);
    } catch (err) {
      this.notificationBar?.show(`Page render: ${err.message}`, 'error');
    }
  }

  async _navigatePageSvg(address) {
    if (!this.pageSvgView) return;
    try {
      const position = this.getCurrentTracePosition();
      const data = await this.apiClient.getPageRender({
        major: position?.major,
        minor: position?.minor,
        threadId: this.state.activeThreadId,
        address,
      });
      this.pageSvgView.setData(data);
    } catch (err) {
      this.notificationBar?.show(`Page render: ${err.message}`, 'error');
    }
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
  }

  handleZoomControl(direction) {
    if (direction === 'in') {
      this.viewport.zoom(1.5, this.viewport.width / 2, this.viewport.height / 2);
      this.state.zoomLevel = Math.min(4, this.state.zoomLevel + 1);
    } else if (direction === 'out') {
      this.viewport.zoom(0.67, this.viewport.width / 2, this.viewport.height / 2);
      this.state.zoomLevel = Math.max(0, this.state.zoomLevel - 1);
    } else if (direction === 'reset') {
      this.viewport.resetCamera();
      this.state.zoomLevel = 0;
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
        positionEl.textContent = `${pos.major}:${minor}`;
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
