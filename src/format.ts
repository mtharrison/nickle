// File format constants and slot encoding (design D2). Little-endian throughout.
//
// A slot is 8 bytes, read as two u32 words `lo` and `hi`. The low 3 bits of
// `lo` are the type tag. Inline types (null, booleans, int32) keep their
// payload in `hi`. Offset types store the byte offset of an 8-byte-aligned
// node, so the offset's low 3 bits are free for the tag: offset = (lo & ~7) + hi * 2^32.

export const MAGIC = 0x004c4b4e; // "NKL\0" read as a little-endian u32
export const VERSION = 1;
export const HEADER_SIZE = 32;

export const T_NULL = 0;
export const T_FALSE = 1;
export const T_TRUE = 2;
export const T_INT = 3;
export const T_FLOAT = 4;
export const T_STRING = 5;
export const T_ARRAY = 6;
export const T_OBJECT = 7;

/** STRING node flag: every byte is ASCII. */
export const STR_ASCII = 1;
/** Objects with more keys than this carry a `sortIdx` permutation (D3). */
export const SORT_THRESHOLD = 8;
/** ASCII strings shorter than this decode with a fromCharCode loop (bench/RESULTS.md 2.2). */
export const ASCII_LOOP_MAX = 8;

const TWO_32 = 2 ** 32;

// Header layout (byte offsets).
export const H_MAGIC = 0;
export const H_VERSION = 4;
export const H_FLAGS = 6;
export const H_ROOT = 8;
export const H_KEY_TABLE = 16;
export const H_FILE_LENGTH = 24;

export function isInt32(n: number): boolean {
  return (n | 0) === n && !Object.is(n, -0);
}

export function slotTag(lo: number): number {
  return lo & 7;
}

export function slotOffset(lo: number, hi: number): number {
  return ((lo & ~7) >>> 0) + hi * TWO_32;
}

/** Writes an offset slot at word index `w`. `off` must be 8-byte aligned. */
export function setOffsetSlot(u32: Uint32Array, w: number, tag: number, off: number): void {
  u32[w] = (off % TWO_32) + tag;
  u32[w + 1] = Math.floor(off / TWO_32);
}

/** Writes an inline slot (null, boolean or int32) at word index `w`. */
export function setInlineSlot(u32: Uint32Array, w: number, tag: number, payload = 0): void {
  u32[w] = tag;
  u32[w + 1] = payload;
}

export interface Header {
  magic: number;
  version: number;
  flags: number;
  rootLo: number;
  rootHi: number;
  keyTableOffset: number;
  fileLength: number;
}

export function writeHeader(dv: DataView, h: Omit<Header, "magic" | "version">): void {
  dv.setUint32(H_MAGIC, MAGIC, true);
  dv.setUint16(H_VERSION, VERSION, true);
  dv.setUint16(H_FLAGS, h.flags, true);
  dv.setUint32(H_ROOT, h.rootLo, true);
  dv.setUint32(H_ROOT + 4, h.rootHi, true);
  dv.setBigUint64(H_KEY_TABLE, BigInt(h.keyTableOffset), true);
  dv.setBigUint64(H_FILE_LENGTH, BigInt(h.fileLength), true);
}

export function readHeader(dv: DataView): Header {
  return {
    magic: dv.getUint32(H_MAGIC, true),
    version: dv.getUint16(H_VERSION, true),
    flags: dv.getUint16(H_FLAGS, true),
    rootLo: dv.getUint32(H_ROOT, true),
    rootHi: dv.getUint32(H_ROOT + 4, true),
    keyTableOffset: Number(dv.getBigUint64(H_KEY_TABLE, true)),
    fileLength: Number(dv.getBigUint64(H_FILE_LENGTH, true)),
  };
}

export const align8 = (n: number): number => n + ((8 - (n % 8)) % 8);
