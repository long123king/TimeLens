import { Graphics, Text, Container } from 'pixi.js';

/**
 * HexRenderer - Renders hex dump and bit-level views
 */
export default class HexRenderer {
  constructor() {}

  /**
   * Render byte-level hex grid
   */
  renderByteGrid(container, memoryData, focusAddress, width, height) {
    if (!memoryData || !memoryData.data) {
      this.renderEmptyState(container, width, height);
      return;
    }

    // Decode base64 memory data
    const binaryString = atob(memoryData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const bytesPerRow = 16;
    const cellWidth = 25;
    const cellHeight = 25;
    const spacing = 2;

    // Title
    const title = new Text({
      text: `Hex View - Address 0x${focusAddress.toString(16).toUpperCase()}`,
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 12,
        fill: 0x858585,
      }
    });
    title.x = 10;
    title.y = 10;
    container.addChild(title);

    // Column headers (byte offsets)
    for (let col = 0; col < bytesPerRow; col++) {
      const header = new Text({
        text: col.toString(16).toUpperCase(),
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 9,
          fill: 0x858585,
        }
      });
      header.x = 80 + col * (cellWidth + spacing) + cellWidth / 2 - header.width / 2;
      header.y = 35;
      container.addChild(header);
    }

    // Render bytes
    const maxRows = Math.floor((height - 60) / (cellHeight + spacing));
    const visibleBytes = Math.min(bytes.length, maxRows * bytesPerRow);

    for (let i = 0; i < visibleBytes; i++) {
      const row = Math.floor(i / bytesPerRow);
      const col = i % bytesPerRow;

      // Row header (address)
      if (col === 0) {
        const rowHeader = new Text({
          text: '0x' + (focusAddress + i).toString(16).padStart(8, '0').toUpperCase(),
          style: {
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 9,
            fill: 0x858585,
          }
        });
        rowHeader.x = 10;
        rowHeader.y = 55 + row * (cellHeight + spacing) + cellHeight / 2 - rowHeader.height / 2;
        container.addChild(rowHeader);
      }

      // Byte cell
      const byte = bytes[i];
      const cell = new Graphics();

      // Color based on byte value
      const color = this.getByteColor(byte);

      cell.rect(0, 0, cellWidth, cellHeight);
      cell.fill(color);
      cell.rect(0, 0, cellWidth, cellHeight);
      cell.stroke({ width: 1, color: 0x3c3c3c });

      cell.x = 80 + col * (cellWidth + spacing);
      cell.y = 55 + row * (cellHeight + spacing);

      cell.eventMode = 'static';
      cell.cursor = 'pointer';

      container.addChild(cell);

      // Byte value text
      const byteText = new Text({
        text: byte.toString(16).padStart(2, '0').toUpperCase(),
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 9,
          fill: 0xffffff,
        }
      });
      byteText.x = cell.x + cellWidth / 2 - byteText.width / 2;
      byteText.y = cell.y + cellHeight / 2 - byteText.height / 2;
      container.addChild(byteText);
    }

    // ASCII column on the right
    this.renderAsciiColumn(container, bytes, visibleBytes, bytesPerRow, cellHeight, spacing, width);
  }

  /**
   * Render ASCII representation column
   */
  renderAsciiColumn(container, bytes, visibleBytes, bytesPerRow, cellHeight, spacing, width) {
    const asciiX = width - 200;

    const asciiTitle = new Text({
      text: 'ASCII',
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 10,
        fill: 0x858585,
      }
    });
    asciiTitle.x = asciiX;
    asciiTitle.y = 35;
    container.addChild(asciiTitle);

    const rows = Math.ceil(visibleBytes / bytesPerRow);

    for (let row = 0; row < rows; row++) {
      let asciiStr = '';
      for (let col = 0; col < bytesPerRow; col++) {
        const index = row * bytesPerRow + col;
        if (index < visibleBytes) {
          const byte = bytes[index];
          if (byte >= 32 && byte <= 126) {
            asciiStr += String.fromCharCode(byte);
          } else {
            asciiStr += '.';
          }
        }
      }

      const asciiText = new Text({
        text: asciiStr,
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 10,
          fill: 0x4ec9b0,
        }
      });
      asciiText.x = asciiX;
      asciiText.y = 55 + row * (cellHeight + spacing) + cellHeight / 2 - asciiText.height / 2;
      container.addChild(asciiText);
    }
  }

  /**
   * Render bit-level view
   */
  renderBitGrid(container, memoryData, focusAddress, width, height) {
    if (!memoryData || !memoryData.data) {
      this.renderEmptyState(container, width, height);
      return;
    }

    // Decode base64 memory data
    const binaryString = atob(memoryData.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const bitsPerByte = 8;
    const bitWidth = 15;
    const bitHeight = 15;
    const spacing = 1;
    const byteSpacing = 5;

    // Title
    const title = new Text({
      text: `Bit View - Address 0x${focusAddress.toString(16).toUpperCase()}`,
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 12,
        fill: 0x858585,
      }
    });
    title.x = 10;
    title.y = 10;
    container.addChild(title);

    // Show first 32 bytes (256 bits)
    const bytesToShow = Math.min(32, bytes.length);

    for (let byteIndex = 0; byteIndex < bytesToShow; byteIndex++) {
      const byte = bytes[byteIndex];
      const row = Math.floor(byteIndex / 4);
      const col = byteIndex % 4;

      const baseX = 10 + col * (bitsPerByte * (bitWidth + spacing) + byteSpacing);
      const baseY = 40 + row * (bitHeight + spacing + 20);

      // Byte label
      const byteLabel = new Text({
        text: `0x${byte.toString(16).padStart(2, '0').toUpperCase()}`,
        style: {
          fontFamily: 'Consolas, Monaco, monospace',
          fontSize: 9,
          fill: 0x858585,
        }
      });
      byteLabel.x = baseX;
      byteLabel.y = baseY - 15;
      container.addChild(byteLabel);

      // Render each bit
      for (let bit = 0; bit < bitsPerByte; bit++) {
        const bitValue = (byte >> (7 - bit)) & 1;

        const bitCell = new Graphics();
        const color = bitValue ? 0x4ec9b0 : 0x2d2d30;

        bitCell.rect(0, 0, bitWidth, bitHeight);
        bitCell.fill(color);
        bitCell.rect(0, 0, bitWidth, bitHeight);
        bitCell.stroke({ width: 1, color: 0x3c3c3c });

        bitCell.x = baseX + bit * (bitWidth + spacing);
        bitCell.y = baseY;

        bitCell.eventMode = 'static';
        bitCell.cursor = 'pointer';

        container.addChild(bitCell);

        // Bit value text
        const bitText = new Text({
          text: bitValue.toString(),
          style: {
            fontFamily: 'Consolas, Monaco, monospace',
            fontSize: 9,
            fill: bitValue ? 0xffffff : 0x858585,
          }
        });
        bitText.x = bitCell.x + bitWidth / 2 - bitText.width / 2;
        bitText.y = bitCell.y + bitHeight / 2 - bitText.height / 2;
        container.addChild(bitText);
      }
    }
  }

  /**
   * Get color for byte based on value
   */
  getByteColor(byte) {
    if (byte === 0x00) return 0x1e1e1e; // Null
    if (byte === 0xFF) return 0xff6b6b; // Max
    if (byte >= 0x20 && byte <= 0x7E) return 0x4ec9b0; // Printable ASCII
    if (byte >= 0x80) return 0x569cd6; // High byte
    return 0x2d2d30; // Other
  }

  /**
   * Render empty state
   */
  renderEmptyState(container, width, height) {
    const text = new Text({
      text: 'No memory data available',
      style: {
        fontFamily: 'Consolas, Monaco, monospace',
        fontSize: 14,
        fill: 0x858585,
      }
    });
    text.x = width / 2 - text.width / 2;
    text.y = height / 2 - text.height / 2;
    container.addChild(text);
  }
}
