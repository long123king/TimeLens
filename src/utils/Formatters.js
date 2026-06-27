/**
 * Formatters - Utility functions for formatting data
 */
export default class Formatters {
  /**
   * Format address as hex string
   */
  static formatAddress(address, padding = 8) {
    const addr = typeof address === 'string' ? parseInt(address, 16) : address;
    return '0x' + addr.toString(16).padStart(padding, '0').toUpperCase();
  }

  /**
   * Format byte as hex string
   */
  static formatByte(byte) {
    return byte.toString(16).padStart(2, '0').toUpperCase();
  }

  /**
   * Format size in human-readable format
   */
  static formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /**
   * Format time in milliseconds
   */
  static formatTime(ms) {
    if (ms < 1000) return ms.toFixed(0) + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(2) + 's';
    return (ms / 60000).toFixed(2) + 'm';
  }

  /**
   * Convert byte to binary string
   */
  static byteToBinary(byte) {
    return byte.toString(2).padStart(8, '0');
  }

  /**
   * Parse hex string to number
   */
  static parseHex(hexStr) {
    return parseInt(hexStr.replace('0x', ''), 16);
  }

  /**
   * Format register value
   */
  static formatRegister(name, value) {
    return `${name.toUpperCase()}: ${this.formatAddress(value, 16)}`;
  }
}
