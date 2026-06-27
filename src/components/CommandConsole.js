const MAX_HISTORY_ITEMS = 100;

/**
 * CommandConsole - Manages the command tab for WinDbg command execution.
 */
export default class CommandConsole {
  constructor(element) {
    this.element = element;
    this.history = [];
    this.historyCursor = 0;
    this.draftCommand = '';
    this.isExecuting = false;
    this.selectedEntryId = null;

    this.form = this.element?.querySelector('#command-form') ?? null;
    this.input = this.element?.querySelector('#command-input') ?? null;
    this.submitButton = this.element?.querySelector('#command-submit') ?? null;
    this.historyList = this.element?.querySelector('#command-history-list') ?? null;
    this.outputHeader = this.element?.querySelector('#command-output-command') ?? null;
    this.outputMeta = this.element?.querySelector('#command-output-meta') ?? null;
    this.outputBody = this.element?.querySelector('#command-output') ?? null;

    this.setupEventListeners();
    this.render();
  }

  setupEventListeners() {
    this.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.handleSubmit();
    });

    this.input?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveHistoryCursor(-1);
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.moveHistoryCursor(1);
      }
    });

    this.historyList?.addEventListener('click', (event) => {
      const entry = event.target.closest('[data-command-entry-id]');
      if (!entry) return;

      this.selectEntry(entry.dataset.commandEntryId);
    });
  }

  async handleSubmit() {
    if (!this.onExecute || this.isExecuting) {
      return;
    }

    const command = this.input?.value.trim() ?? '';
    if (!command) {
      return;
    }

    const entry = this.createEntry(command);
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY_ITEMS) {
      this.history.shift();
    }

    this.selectedEntryId = entry.id;
    this.historyCursor = this.history.length;
    this.draftCommand = '';
    this.setExecuting(true);
    this.render();

    try {
      const response = await this.onExecute(command);
      const output = this.normalizeOutput(response);
      entry.status = 'success';
      entry.output = output.text;
      entry.lineCount = output.lineCount;
      entry.requestId = response?.requestId ?? null;
    } catch (error) {
      entry.status = 'error';
      entry.output = error?.message ?? 'Command execution failed.';
      entry.lineCount = 0;
    } finally {
      this.setExecuting(false);
      if (this.input) {
        this.input.value = '';
      }
      this.historyCursor = this.history.length;
      this.render();
      this.focusInput();
    }
  }

  normalizeOutput(response) {
    const payload = response?.command ?? {};
    const lines = Array.isArray(payload.lines) ? payload.lines : [];
    const text = typeof payload.output === 'string'
      ? payload.output
      : lines.join('\n');

    return {
      text: text || '(no output)',
      lineCount: typeof payload.lineCount === 'number' ? payload.lineCount : lines.length,
    };
  }

  createEntry(command) {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      command,
      output: 'Executing command...',
      lineCount: 0,
      requestId: null,
      status: 'running',
      executedAt: new Date(),
    };
  }

  moveHistoryCursor(direction) {
    if (!this.input || this.history.length === 0 || this.isExecuting) {
      return;
    }

    if (direction < 0 && this.historyCursor === this.history.length) {
      this.draftCommand = this.input.value;
    }

    const nextCursor = Math.max(0, Math.min(this.history.length, this.historyCursor + direction));
    this.historyCursor = nextCursor;

    if (this.historyCursor === this.history.length) {
      this.input.value = this.draftCommand;
      return;
    }

    this.input.value = this.history[this.historyCursor]?.command ?? '';
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  selectEntry(entryId) {
    this.selectedEntryId = entryId;
    this.render();
  }

  setExecuting(executing) {
    this.isExecuting = executing;
    if (this.input) {
      this.input.disabled = executing;
    }
    if (this.submitButton) {
      this.submitButton.disabled = executing;
      this.submitButton.textContent = executing ? 'Running...' : 'Run';
    }
  }

  setActive(active) {
    if (active) {
      this.focusInput();
    }
  }

  focusInput() {
    this.input?.focus();
  }

  getSelectedEntry() {
    if (this.history.length === 0) {
      return null;
    }

    return this.history.find((entry) => entry.id === this.selectedEntryId)
      ?? this.history[this.history.length - 1];
  }

  render() {
    this.renderHistory();
    this.renderOutput();
  }

  renderHistory() {
    if (!this.historyList) {
      return;
    }

    if (this.history.length === 0) {
      this.historyList.innerHTML = '<div class="command-history-empty">No commands executed yet.</div>';
      return;
    }

    const items = [...this.history].reverse().map((entry) => {
      const isActive = entry.id === this.getSelectedEntry()?.id;
      const timestamp = entry.executedAt.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });

      return `
        <button
          type="button"
          class="command-history-item${isActive ? ' active' : ''}"
          data-command-entry-id="${entry.id}"
        >
          <span class="command-history-status ${entry.status}"></span>
          <span class="command-history-command">${this.escapeHtml(entry.command)}</span>
          <span class="command-history-time">${timestamp}</span>
        </button>
      `;
    });

    this.historyList.innerHTML = items.join('');
  }

  renderOutput() {
    if (!this.outputBody || !this.outputHeader || !this.outputMeta) {
      return;
    }

    if (this.history.length === 0) {
      this.outputHeader.textContent = 'Command transcript';
      this.outputMeta.textContent = 'Run a WinDbg command to start the transcript.';
      this.outputBody.innerHTML = `
        <div class="command-transcript-empty">
          <div class="command-transcript-empty-title">No command output yet</div>
          <div class="command-transcript-empty-copy">Each command will appear here as an input block followed by its output.</div>
        </div>
      `;
      return;
    }

    const selectedEntry = this.getSelectedEntry();
    this.outputHeader.textContent = 'Command transcript';
    this.outputMeta.textContent = `${this.history.length} command${this.history.length === 1 ? '' : 's'} in session`;
    this.outputBody.innerHTML = this.history.map((entry, index) => this.renderTranscriptEntry(entry, index)).join('');

    if (selectedEntry) {
      this.scrollOutputToEntry(selectedEntry.id, selectedEntry.id === this.history[this.history.length - 1]?.id);
    }
  }

  renderTranscriptEntry(entry, index) {
    const timestamp = entry.executedAt.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const statusText = entry.status === 'error'
      ? 'failed'
      : entry.status === 'running'
        ? 'running'
        : 'completed';
    const isActive = entry.id === this.getSelectedEntry()?.id;
    const escapedOutput = this.escapeHtml(entry.output || '(no output)');

    return `
      <article class="command-transcript-entry${isActive ? ' active' : ''}" data-output-entry-id="${entry.id}">
        <div class="command-transcript-block command-transcript-input-block">
          <div class="command-transcript-label-row">
            <span class="command-transcript-label">Input</span>
            <span class="command-transcript-meta">${timestamp}</span>
          </div>
          <div class="command-transcript-command">${this.escapeHtml(entry.command)}</div>
        </div>
        <div class="command-transcript-separator">
          <span class="command-transcript-separator-line"></span>
          <span class="command-transcript-separator-index">${String(index + 1).padStart(2, '0')}</span>
          <span class="command-transcript-separator-line"></span>
        </div>
        <div class="command-transcript-block command-transcript-output-block ${entry.status}">
          <div class="command-transcript-label-row">
            <span class="command-transcript-label">Output</span>
            <span class="command-transcript-meta">${statusText} - ${entry.lineCount} line${entry.lineCount === 1 ? '' : 's'}</span>
          </div>
          <pre class="command-transcript-output">${escapedOutput}</pre>
        </div>
      </article>
    `;
  }

  scrollOutputToEntry(entryId, alignToBottom = false) {
    if (!this.outputBody) {
      return;
    }

    requestAnimationFrame(() => {
      const entry = this.outputBody.querySelector(`[data-output-entry-id="${entryId}"]`);
      if (!entry) {
        return;
      }

      if (alignToBottom) {
        this.outputBody.scrollTop = this.outputBody.scrollHeight;
        return;
      }

      entry.scrollIntoView({ block: 'nearest' });
    });
  }

  escapeHtml(text) {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  onExecute = null;
}