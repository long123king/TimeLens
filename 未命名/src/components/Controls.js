/**
 * Controls - Manages HTML UI controls overlay
 * Bridges between HTML elements and application logic
 */
export default class Controls {
  constructor() {
    this.isPlaying = false;

    this.setupEventListeners();
  }

  setupEventListeners() {
    // Playback controls
    document.getElementById('btn-play')?.addEventListener('click', () => {
      if (this.onPlayPause) {
        this.onPlayPause();
      }
    });

    document.getElementById('btn-pause')?.addEventListener('click', () => {
      if (this.onPlayPause) {
        this.onPlayPause();
      }
    });

    document.getElementById('btn-step-back')?.addEventListener('click', () => {
      if (this.onStep) {
        this.onStep(-1);
      }
    });

    document.getElementById('btn-step-forward')?.addEventListener('click', () => {
      if (this.onStep) {
        this.onStep(1);
      }
    });

    // Zoom controls
    document.getElementById('btn-zoom-in')?.addEventListener('click', () => {
      if (this.onZoom) {
        this.onZoom('in');
      }
    });

    document.getElementById('btn-zoom-out')?.addEventListener('click', () => {
      if (this.onZoom) {
        this.onZoom('out');
      }
    });

    document.getElementById('btn-zoom-reset')?.addEventListener('click', () => {
      if (this.onZoom) {
        this.onZoom('reset');
      }
    });

    // View toggles
    document.getElementById('chk-heatmap')?.addEventListener('change', (e) => {
      if (this.onViewToggle) {
        this.onViewToggle('heatmap', e.target.checked);
      }
    });

    document.getElementById('chk-regions')?.addEventListener('change', (e) => {
      if (this.onViewToggle) {
        this.onViewToggle('regions', e.target.checked);
      }
    });

    document.getElementById('chk-pointers')?.addEventListener('change', (e) => {
      if (this.onViewToggle) {
        this.onViewToggle('pointers', e.target.checked);
      }
    });

    document.getElementById('chk-hex')?.addEventListener('change', (e) => {
      if (this.onViewToggle) {
        this.onViewToggle('hex', e.target.checked);
      }
    });
  }

  setPlaying(playing) {
    this.isPlaying = playing;

    const playBtn = document.getElementById('btn-play');
    const pauseBtn = document.getElementById('btn-pause');

    if (playing) {
      playBtn.style.display = 'none';
      pauseBtn.style.display = 'inline-block';
    } else {
      playBtn.style.display = 'inline-block';
      pauseBtn.style.display = 'none';
    }
  }

  toggleHexDump(visible) {
    const hexPanel = document.getElementById('hex-panel');
    const hexContent = document.getElementById('hex-content');
    if (!hexPanel || !hexContent) return;

    // Keep panel space reserved in layout; only toggle the memory-page content.
    if (visible) {
      hexContent.style.display = 'block';
      hexPanel.style.opacity = '1';
    } else {
      hexContent.style.display = 'none';
      hexPanel.style.opacity = '0.6';
    }
  }

  updateHexDump(address, memoryData) {
    if (!memoryData || !memoryData.data) {
      return;
    }

    const hexContent = document.getElementById('hex-content');
    hexContent.innerHTML = '';

    // Decode base64 memory data
    const binaryString = atob(memoryData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Parse address
    let startAddress = typeof address === 'string' ? parseInt(address, 16) : address;

    // Show 16 rows of 16 bytes each
    const bytesPerRow = 16;
    const rowCount = 16;

    for (let row = 0; row < rowCount; row++) {
      const offset = row * bytesPerRow;
      if (offset >= bytes.length) break;

      const rowDiv = document.createElement('div');
      rowDiv.className = 'hex-row';

      // Address
      const addrSpan = document.createElement('span');
      addrSpan.className = 'hex-address';
      addrSpan.textContent = '0x' + (startAddress + offset).toString(16).padStart(8, '0').toUpperCase();
      rowDiv.appendChild(addrSpan);

      // Hex bytes
      const hexSpan = document.createElement('span');
      hexSpan.className = 'hex-bytes';
      let hexText = '';
      let asciiText = '';

      for (let col = 0; col < bytesPerRow; col++) {
        const byteIndex = offset + col;
        if (byteIndex < bytes.length) {
          const byte = bytes[byteIndex];
          hexText += byte.toString(16).padStart(2, '0').toUpperCase() + ' ';

          // ASCII representation
          if (byte >= 32 && byte <= 126) {
            asciiText += String.fromCharCode(byte);
          } else {
            asciiText += '.';
          }
        }
      }

      hexSpan.textContent = hexText;
      rowDiv.appendChild(hexSpan);

      // ASCII
      const asciiSpan = document.createElement('span');
      asciiSpan.className = 'hex-ascii';
      asciiSpan.textContent = asciiText;
      rowDiv.appendChild(asciiSpan);

      hexContent.appendChild(rowDiv);
    }
  }

  // Callbacks (set by parent)
  onPlayPause = null;
  onStep = null;
  onZoom = null;
  onViewToggle = null;
}
