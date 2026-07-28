#!/usr/bin/env node
/**
 * Convert a splat selection mask JSON to the compact binary bitfield (.bin) the
 * viewer loads via `buildMaskFromBitfield`. The .bin is ~total/8 bytes — orders
 * of magnitude smaller than the index-list JSON (e.g. ~150 KB vs 25 MB).
 *
 * Accepts either mask JSON shape:
 *   - compact:  { "total": N, "indices": [i, j, ...] }
 *   - editor:   [{ "mask": [0,1,...], "numSplats": N }]
 *
 * Output format (matches buildMaskFromBitfield in SplatMaskTexture.ts):
 *   bytes 0..3 : uint32 LE  total splat count
 *   bytes 4..  : ceil(total/8) bytes, bit i (byte i>>3, bit i&7) set = selected
 *
 * Usage:
 *   node scripts/mask-to-bin.mjs <input.json> [output.bin]
 *   node scripts/mask-to-bin.mjs assets/splats/alsvin/alsvin_mask.json   (per file)
 *   shell glob also works: scripts/mask-to-bin.mjs assets/splats/[asterisk]/[asterisk]_mask.json
 */
import { readFileSync, writeFileSync } from "fs";

function convert(input, output) {
  const raw = JSON.parse(readFileSync(input, "utf8"));
  let total;
  let indices;
  if (Array.isArray(raw)) {
    const e = raw[0];
    if (!e || !Array.isArray(e.mask)) {
      throw new Error(`${input}: expected [{ mask: [...], numSplats }]`);
    }
    total = typeof e.numSplats === "number" ? e.numSplats : e.mask.length;
    indices = [];
    for (let i = 0; i < e.mask.length; i++) if (e.mask[i]) indices.push(i);
  } else if (raw && typeof raw.total === "number" && Array.isArray(raw.indices)) {
    total = raw.total;
    indices = raw.indices;
  } else {
    throw new Error(`${input}: unrecognized mask JSON (need {total,indices} or [{mask,numSplats}])`);
  }

  const nbytes = Math.ceil(total / 8);
  const buf = Buffer.alloc(4 + nbytes);
  buf.writeUInt32LE(total, 0);
  let selected = 0;
  for (const i of indices) {
    if (i >= 0 && i < total) {
      buf[4 + (i >> 3)] |= 1 << (i & 7);
      selected++;
    }
  }

  const out = output ?? input.replace(/\.json$/i, ".bin");
  writeFileSync(out, buf);
  console.log(
    `${input} -> ${out}: total=${total}, selected=${selected}, ${buf.length} bytes ` +
      `(was ${readFileSync(input).length} bytes JSON)`
  );
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/mask-to-bin.mjs <input.json> [output.bin]");
  process.exit(1);
}
// If exactly two args and the second ends in .bin, treat as input/output pair;
// otherwise treat every arg as an input (default output = input with .bin).
if (args.length === 2 && /\.bin$/i.test(args[1])) {
  convert(args[0], args[1]);
} else {
  for (const a of args) convert(a);
}
