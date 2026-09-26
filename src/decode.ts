// Buffer decoding shared by views and materialize (design D5, D6).

import {
  ASCII_LOOP_MAX, STR_ASCII,
  T_ARRAY, T_FALSE, T_FLOAT, T_INT, T_NULL, T_OBJECT, T_STRING, T_TRUE,
} from "./format.js";

const TWO_32 = 4294967296;
const td = new TextDecoder("utf-8", { fatal: false });

interface Latin1Buffer extends Buffer {
  latin1Slice(start: number, end: number): string;
}

/** Everything a view or decoder needs to read one open file. */
export class Ctx {
  u8: Uint8Array;
  u32: Uint32Array;
  f64: Float64Array;
  buf: Latin1Buffer;
  keys: string[];
  keyMap: Map<string, number>;
  /** Key id of "__proto__", or -1. Materialize must define it, not assign it. */
  protoId: number;
  closed = false;

  constructor(ab: ArrayBuffer, keys: string[]) {
    this.u8 = new Uint8Array(ab);
    this.u32 = new Uint32Array(ab, 0, ab.byteLength >>> 2);
    this.f64 = new Float64Array(ab, 0, Math.floor(ab.byteLength / 8));
    this.buf = Buffer.from(ab) as Latin1Buffer;
    this.keys = keys;
    this.keyMap = new Map(keys.map((k, i) => [k, i]));
    this.protoId = this.keyMap.get("__proto__") ?? -1;
  }
}

export function offsetOf(lo: number, hi: number): number {
  return ((lo & ~7) >>> 0) + hi * TWO_32;
}

/** Decodes the STRING node at byte offset `off`. */
export function decodeString(ctx: Ctx, off: number): string {
  const u8 = ctx.u8;
  const len = ctx.u32[off / 4 + 1];
  const a = off + 8;
  if (u8[off + 1] & STR_ASCII) {
    if (len < ASCII_LOOP_MAX) {
      let s = "";
      for (let i = 0; i < len; i++) s += String.fromCharCode(u8[a + i]);
      return s;
    }
    return ctx.buf.latin1Slice(a, a + len);
  }
  return td.decode(u8.subarray(a, a + len));
}

/** Decodes a leaf slot. Returns `undefined` for containers. */
export function decodeLeaf(ctx: Ctx, lo: number, hi: number): unknown {
  switch (lo & 7) {
    case T_NULL: return null;
    case T_FALSE: return false;
    case T_TRUE: return true;
    case T_INT: return hi | 0;
    case T_FLOAT: return ctx.f64[offsetOf(lo, hi) / 8];
    case T_STRING: return decodeString(ctx, offsetOf(lo, hi));
  }
  return undefined;
}

/** Eagerly decodes the slot (lo, hi) into plain JS values. */
export function materializeSlot(ctx: Ctx, lo: number, hi: number): unknown {
  switch (lo & 7) {
    case T_NULL: return null;
    case T_FALSE: return false;
    case T_TRUE: return true;
    case T_INT: return hi | 0;
    case T_FLOAT: return ctx.f64[offsetOf(lo, hi) / 8];
    case T_STRING: return decodeString(ctx, offsetOf(lo, hi));
    case T_ARRAY: return materializeArray(ctx, offsetOf(lo, hi) / 4);
    case T_OBJECT: return materializeObject(ctx, offsetOf(lo, hi) / 4);
  }
}

/** `w` is the word index of an ARRAY node. */
export function materializeArray(ctx: Ctx, w: number): unknown[] {
  const u32 = ctx.u32;
  const n = u32[w + 1];
  const a: unknown[] = [];
  for (let i = 0, s = w + 2; i < n; i++, s += 2) a.push(materializeSlot(ctx, u32[s], u32[s + 1]));
  return a;
}

/** `w` is the word index of an OBJECT node. */
export function materializeObject(ctx: Ctx, w: number): Record<string, unknown> {
  const u32 = ctx.u32;
  const keys = ctx.keys;
  const protoId = ctx.protoId;
  const n = u32[w + 1];
  const ids = w + 2;
  const o: Record<string, unknown> = {};
  for (let i = 0, s = ids + n + (n & 1); i < n; i++, s += 2) {
    const id = u32[ids + i];
    const v = materializeSlot(ctx, u32[s], u32[s + 1]);
    if (id === protoId) {
      Object.defineProperty(o, "__proto__", { value: v, writable: true, enumerable: true, configurable: true });
    } else {
      o[keys[id]] = v;
    }
  }
  return o;
}
