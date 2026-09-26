// Read-only Proxy views (design D3, D4). Each container view is a Proxy over a
// real target ({} or a length-n []), so Array.isArray and Proxy invariants hold.
// One handler instance per view carries the node's position in the buffer.

import { Ctx, decodeLeaf, offsetOf } from "./decode.js";
import { NickleError } from "./errors.js";
import { SORT_THRESHOLD, T_ARRAY, T_OBJECT } from "./format.js";

/** Symbol a view answers with its handler; used by materialize. */
export const VIEW = Symbol("nickle.view");

const closed = (): never => {
  throw new NickleError("NICKLE_CLOSED", "the handle for this view is closed");
};
const readOnly = (): never => {
  throw new TypeError("nickle: views are read-only; use materialize() for a mutable copy");
};

/** Parses a canonical array index ("0", "17"; not "01", "1e3", "-1"), or returns -1. */
function parseIndex(key: string): number {
  const n = key.length;
  if (n === 0 || n > 10 || (n > 1 && key.charCodeAt(0) === 48)) return -1;
  let i = 0;
  for (let j = 0; j < n; j++) {
    const c = key.charCodeAt(j) - 48;
    if (c < 0 || c > 9) return -1;
    i = i * 10 + c;
  }
  return i < 4294967295 ? i : -1;
}

abstract class Base implements ProxyHandler<object> {
  readonly ctx: Ctx;
  /** Word index of this node. */
  readonly w: number;
  /** Word index of this node's first slot. */
  readonly slotW: number;
  readonly n: number;
  private cache: Map<number, object> | undefined = undefined;

  constructor(ctx: Ctx, w: number, slotW: number) {
    this.ctx = ctx;
    this.w = w;
    this.n = ctx.u32[w + 1];
    this.slotW = slotW;
  }

  /** Decodes slot `pos`, reusing child views for stable identity. */
  slot(pos: number): unknown {
    const u32 = this.ctx.u32;
    const s = this.slotW + pos * 2;
    const lo = u32[s];
    const tag = lo & 7;
    if (tag < T_ARRAY) return decodeLeaf(this.ctx, lo, u32[s + 1]);
    let cache = this.cache;
    if (cache === undefined) cache = this.cache = new Map();
    let v = cache.get(pos);
    if (v === undefined) {
      const w = offsetOf(lo, u32[s + 1]) / 4;
      v = tag === T_OBJECT ? objectView(this.ctx, w) : arrayView(this.ctx, w);
      cache.set(pos, v);
    }
    return v;
  }

  set(): boolean { return this.ctx.closed ? closed() : readOnly(); }
  defineProperty(): boolean { return this.ctx.closed ? closed() : readOnly(); }
  deleteProperty(): boolean { return this.ctx.closed ? closed() : readOnly(); }
  setPrototypeOf(): boolean { return this.ctx.closed ? closed() : readOnly(); }
  preventExtensions(): boolean { return this.ctx.closed ? closed() : readOnly(); }
}

export class ObjectHandler extends Base {
  readonly isArray = false;

  constructor(ctx: Ctx, w: number) {
    const n = ctx.u32[w + 1];
    super(ctx, w, w + 2 + n + (n & 1));
  }

  /** Position of `key` in this object, or -1. */
  find(key: string): number {
    const ctx = this.ctx;
    const id = ctx.keyMap.get(key);
    if (id === undefined) return -1;
    const u32 = ctx.u32;
    const ids = this.w + 2;
    const n = this.n;
    if (n <= SORT_THRESHOLD) {
      for (let i = 0; i < n; i++) if (u32[ids + i] === id) return i;
      return -1;
    }
    const sort = this.slotW + n * 2;
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const p = u32[sort + mid];
      const k = u32[ids + p];
      if (k === id) return p;
      if (k < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get(target: object, key: string | symbol, receiver: unknown): unknown {
    if (this.ctx.closed) closed();
    if (typeof key === "string") {
      const pos = this.find(key);
      if (pos >= 0) return this.slot(pos);
    } else if (key === VIEW) {
      return this;
    }
    return Reflect.get(target, key, receiver);
  }

  has(target: object, key: string | symbol): boolean {
    if (this.ctx.closed) closed();
    return (typeof key === "string" && this.find(key) >= 0) || Reflect.has(target, key);
  }

  ownKeys(): string[] {
    const ctx = this.ctx;
    if (ctx.closed) closed();
    const out = new Array<string>(this.n);
    for (let i = 0, ids = this.w + 2; i < this.n; i++) out[i] = ctx.keys[ctx.u32[ids + i]];
    return out;
  }

  getOwnPropertyDescriptor(_target: object, key: string | symbol): PropertyDescriptor | undefined {
    if (this.ctx.closed) closed();
    const pos = typeof key === "string" ? this.find(key) : -1;
    if (pos < 0) return undefined;
    return { value: this.slot(pos), writable: false, enumerable: true, configurable: true };
  }
}

export class ArrayHandler extends Base {
  readonly isArray = true;

  constructor(ctx: Ctx, w: number) {
    super(ctx, w, w + 2);
  }

  get(target: object, key: string | symbol, receiver: unknown): unknown {
    if (this.ctx.closed) closed();
    if (typeof key === "string") {
      const c = key.charCodeAt(0);
      if (c >= 48 && c <= 57) {
        const i = parseIndex(key);
        if (i >= 0) return i < this.n ? this.slot(i) : undefined;
      } else if (key === "length") {
        return this.n;
      }
    } else if (key === VIEW) {
      return this;
    }
    return Reflect.get(target, key, receiver);
  }

  has(target: object, key: string | symbol): boolean {
    if (this.ctx.closed) closed();
    if (typeof key === "string") {
      const i = parseIndex(key);
      if (i >= 0) return i < this.n;
    }
    return Reflect.has(target, key);
  }

  ownKeys(): string[] {
    if (this.ctx.closed) closed();
    const out = new Array<string>(this.n + 1);
    for (let i = 0; i < this.n; i++) out[i] = String(i);
    out[this.n] = "length";
    return out;
  }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    if (this.ctx.closed) closed();
    if (typeof key === "string") {
      const i = parseIndex(key);
      if (i >= 0) {
        return i < this.n ? { value: this.slot(i), writable: false, enumerable: true, configurable: true } : undefined;
      }
    }
    // `length` is a non-configurable own property of the target, so it must be reported as-is.
    return Reflect.getOwnPropertyDescriptor(target, key);
  }
}

export function objectView(ctx: Ctx, w: number): object {
  return new Proxy({}, new ObjectHandler(ctx, w));
}

export function arrayView(ctx: Ctx, w: number): object {
  const target: unknown[] = [];
  target.length = ctx.u32[w + 1];
  return new Proxy(target, new ArrayHandler(ctx, w));
}

/** Returns the handler behind a view, or undefined for anything else. */
export function handlerOf(v: unknown): ObjectHandler | ArrayHandler | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const h = (v as { [VIEW]?: unknown })[VIEW];
  return h instanceof ObjectHandler || h instanceof ArrayHandler ? h : undefined;
}

