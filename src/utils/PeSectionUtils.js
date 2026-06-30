const IMAGE_SCN_MEM_EXECUTE = 0x20000000;
const IMAGE_SCN_MEM_READ = 0x40000000;
const IMAGE_SCN_MEM_WRITE = 0x80000000;

export function parsePeBigInt(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? BigInt(Math.trunc(value)) : null;
  }
  const text = String(value).trim();
  if (!text) return null;
  try {
    if (/^[-+]?0x/i.test(text)) return BigInt(text);
    if (/^[-+]?\d+$/.test(text)) return BigInt(text);
    if (/^[-+]?[0-9a-f]+$/i.test(text)) return BigInt(text.replace(/^([-+]?)/, '$10x'));
  } catch {
    return null;
  }
  return null;
}

export function parsePeCharacteristics(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? (value >>> 0) : 0;
  if (typeof value === 'bigint') return Number(value & 0xFFFFFFFFn);
  const text = String(value).trim();
  if (!text) return 0;
  const normalized = text.replace(/^0x/i, '');
  const parsed = Number.parseInt(normalized, 16);
  return Number.isFinite(parsed) ? (parsed >>> 0) : 0;
}

export function getPeSectionPermission(characteristics) {
  const chars = parsePeCharacteristics(characteristics);
  let perm = '';
  if (chars & IMAGE_SCN_MEM_READ) perm += 'r';
  if (chars & IMAGE_SCN_MEM_WRITE) perm += 'w';
  if (chars & IMAGE_SCN_MEM_EXECUTE) perm += 'x';
  return perm;
}

export function getPeSectionSpan(section, moduleBase = 0n) {
  const base = parsePeBigInt(moduleBase) ?? 0n;
  const absoluteAddress = parsePeBigInt(section?.address);
  const virtualAddress = parsePeBigInt(section?.virtualAddress) ?? 0n;
  const start = absoluteAddress != null && (base === 0n || absoluteAddress >= base)
    ? absoluteAddress
    : base + virtualAddress;

  let size = parsePeBigInt(section?.virtualSize) ?? 0n;
  if (size === 0n) size = parsePeBigInt(section?.rawSize) ?? 0n;
  if (size === 0n) return null;

  return {
    start,
    size,
    endExclusive: start + size,
  };
}
