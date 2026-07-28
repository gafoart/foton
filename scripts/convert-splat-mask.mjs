#!/usr/bin/env node
/**
 * Converts a splat selection JSON (with full boolean mask array) to a compact
 * index-list format that's ~1000x smaller for sparse selections.
 *
 * Input:  [{ "numSplats": 1519451, "mask": [0, 0, 1, ...], ... }]
 * Output: { "total": 1519451, "indices": [2, 5, 10, ...] }
 *
 * Usage: node scripts/convert-splat-mask.mjs <input.json> [output.json]
 *        Output defaults to <input>_compact.json
 */
import { readFileSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/convert-splat-mask.mjs <input.json> [output.json]");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(input, "utf8"));
const entry = Array.isArray(raw) ? raw[0] : raw;

if (!entry?.mask || !Array.isArray(entry.mask)) {
  console.error("Error: expected [{ mask: [...], numSplats: N }]");
  process.exit(1);
}

const total = entry.numSplats ?? entry.mask.length;
const indices = [];
for (let i = 0; i < entry.mask.length; i++) {
  if (entry.mask[i]) indices.push(i);
}

const output = process.argv[3] ??
  join(dirname(input), basename(input, ".json") + "_compact.json");

const compact = { total, indices };
const json = JSON.stringify(compact);
writeFileSync(output, json, "utf8");

// Also emit a binary bitfield (.bin) — always smaller for dense selections
const binOutput = output.replace(/\.json$/, ".bin");
const byteLen = Math.ceil(total / 8);
const header = Buffer.alloc(4);
header.writeUInt32LE(total, 0);
const bits = Buffer.alloc(byteLen);
for (const idx of indices) {
  bits[idx >> 3] |= 1 << (idx & 7);
}
const bin = Buffer.concat([header, bits]);
writeFileSync(binOutput, bin);

const inputSize = readFileSync(input).length;
const jsonSize = Buffer.byteLength(json);
const binSize = bin.length;
console.log(`Converted: ${indices.length} selected / ${total} total`);
console.log(`  Original JSON:  ${(inputSize / 1024).toFixed(0)} KB`);
console.log(`  Compact JSON:   ${(jsonSize / 1024).toFixed(1)} KB (${(inputSize / jsonSize).toFixed(0)}x smaller) → ${output}`);
console.log(`  Binary bitfield: ${(binSize / 1024).toFixed(1)} KB (${(inputSize / binSize).toFixed(0)}x smaller) → ${binOutput}`);
