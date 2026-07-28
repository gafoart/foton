import * as THREE from "three";

export interface MaskTextureResult {
  texture: THREE.DataTexture;
  width: number;
  height: number;
  selected: number;
  total: number;
}

function allocTexture(total: number): { data: Uint8Array; width: number; height: number; pixels: number } {
  const width = Math.min(total, 4096);
  const height = Math.ceil(total / width);
  const pixels = width * height;
  const data = new Uint8Array(pixels * 4);
  // Fill all alpha to 255
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height, pixels };
}

function finalize(data: Uint8Array, width: number, height: number, selected: number, total: number): MaskTextureResult {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return { texture, width, height, selected, total };
}

/** Build from a full boolean mask array (0/1 per splat) — the original editor format. */
export function buildMaskTexture(mask: ArrayLike<number>): MaskTextureResult {
  const total = mask.length;
  const { data, width, height } = allocTexture(total);
  let selected = 0;
  for (let i = 0; i < total; i++) {
    if (mask[i]) {
      selected++;
      const o = i * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
    }
  }
  return finalize(data, width, height, selected, total);
}

/** Build from compact index-list format: { total, indices: [i, j, ...] } */
export function buildMaskFromIndices(total: number, indices: ArrayLike<number>): MaskTextureResult {
  const { data, width, height } = allocTexture(total);
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (i < total) {
      const o = i * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
    }
  }
  return finalize(data, width, height, indices.length, total);
}

/** Build from binary bitfield (.bin): 4-byte LE uint32 total count, then ceil(total/8) bytes of packed bits. */
export function buildMaskFromBitfield(buffer: ArrayBuffer): MaskTextureResult {
  const view = new DataView(buffer);
  const total = view.getUint32(0, true);
  const expectedBytes = Math.ceil(total / 8);
  const actualBytes = buffer.byteLength - 4;
  // eslint-disable-next-line no-console
  console.log(`[mask-bin] total=${total}, buffer=${buffer.byteLength}B, payload=${actualBytes}B, expected=${expectedBytes}B`);
  if (actualBytes < expectedBytes || total > 100_000_000) {
    // eslint-disable-next-line no-console
    console.error("[mask-bin] corrupt file: header says", total, "splats but payload is", actualBytes, "bytes");
    return buildMaskFromIndices(1, []);
  }
  const { data, width, height } = allocTexture(total);
  const bytes = new Uint8Array(buffer, 4);
  let selected = 0;
  for (let i = 0; i < total; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) {
      selected++;
      const o = i * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[mask-bin] decoded: ${selected} selected, texture ${width}x${height}`);
  return finalize(data, width, height, selected, total);
}

// --- Parsers for the JSON formats ---

export interface SplatSelectionJson {
  id: string;
  name: string;
  numSplats: number;
  mask: number[];
}

/** Original editor format: [{ mask: [0,1,...], numSplats }] */
export function parseSplatSelectionJson(raw: unknown): SplatSelectionJson | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const entry = raw[0] as Partial<SplatSelectionJson>;
  if (!Array.isArray(entry.mask) || typeof entry.numSplats !== "number") return null;
  return entry as SplatSelectionJson;
}

interface CompactMaskJson {
  total: number;
  indices: number[];
}

/** Compact format: { total, indices: [...] } */
function parseCompactJson(raw: unknown): CompactMaskJson | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as { total?: unknown; indices?: unknown };
  if (typeof o.total !== "number" || !Array.isArray(o.indices)) return null;
  return o as CompactMaskJson;
}

/** Auto-detect and parse any JSON mask format. Returns a MaskTextureResult or null. */
export function parseMaskJson(raw: unknown): MaskTextureResult | null {
  // Try compact format first (most common after conversion)
  const compact = parseCompactJson(raw);
  if (compact) return buildMaskFromIndices(compact.total, compact.indices);
  // Try original editor format
  const full = parseSplatSelectionJson(raw);
  if (full) return buildMaskTexture(full.mask);
  return null;
}
