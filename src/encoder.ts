// Encoder (design D2, D8): validates and serializes a value tree into one buffer.
// The walk uses an explicit stack, so nesting depth is not limited by the JS stack.
// Nodes are laid out in depth-first pre-order: a container, then its subtrees.

import {
  HEADER_SIZE, H_ROOT, SORT_THRESHOLD, STR_ASCII,
  T_ARRAY, T_FALSE, T_FLOAT, T_INT, T_NULL, T_OBJECT, T_STRING, T_TRUE,
  align8, isInt32, setInlineSlot, setOffsetSlot, writeHeader,
} from "./format.js";

class Out {
  u8!: Uint8Array;
  u32!: Uint32Array;
  f64!: Float64Array;
  buf!: Buffer;
  pos = 0;

  constructor(cap: number) {
    this.alloc(cap);
  }

  private alloc(cap: number): void {
    const ab = new ArrayBuffer(cap);
    const u8 = new Uint8Array(ab);
    if (this.u8) u8.set(this.u8.subarray(0, this.pos));
    this.u8 = u8;
    this.u32 = new Uint32Array(ab);
    this.f64 = new Float64Array(ab);
    this.buf = Buffer.from(ab);
  }

  ensure(n: number): void {
    const need = this.pos + n;
    if (need > this.u8.length) this.alloc(align8(Math.max(need, this.u8.length * 2)));
  }
}

interface Frame {
  value: any;
  isArray: boolean;
  keys: string[] | null;
  n: number;
  i: number;
  /** Word index of the first slot. */
  slotW: number;
  parent: Frame | null;
  keyInParent: string | number | undefined;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function formatPath(parts: (string | number)[]): string {
  let s = "";
  for (const p of parts) {
    if (typeof p === "number") s += `[${p}]`;
    else if (IDENT.test(p)) s += (s ? "." : "") + p;
    else s += `[${JSON.stringify(p)}]`;
  }
  return s || "<root>";
}

function pathOf(parent: Frame | null, key: string | number | undefined): string {
  const parts: (string | number)[] = [];
  if (key !== undefined) parts.push(key);
  for (let f = parent; f && f.keyInParent !== undefined; f = f.parent) parts.push(f.keyInParent);
  return formatPath(parts.reverse());
}

function describe(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "function") return "function";
  if (typeof v === "symbol") return "symbol";
  if (typeof v === "bigint") return "BigInt";
  try {
    const name = (v as object).constructor?.name;
    if (name) return `${name} instance`;
  } catch {}
  return "object with a non-plain prototype";
}

function reject(what: string, parent: Frame | null, key: string | number | undefined): never {
  throw new TypeError(`nickle: ${what} at ${pathOf(parent, key)}`);
}

export function encode(root: unknown): Buffer {
  const out = new Out(1 << 16);
  out.pos = HEADER_SIZE;
  const keyIds = new Map<string, number>();
  const keyList: string[] = [];
  const ancestors = new Set<object>();
  const stack: Frame[] = [];

  const intern = (k: string, parent: Frame | null, key: string | number | undefined): number => {
    let id = keyIds.get(k);
    if (id === undefined) {
      if (!k.isWellFormed()) reject(`key ${JSON.stringify(k)} contains a lone surrogate`, parent, key);
      id = keyList.length;
      keyIds.set(k, id);
      keyList.push(k);
    }
    return id;
  };

  // Writes `v` into the slot at word index `slotW`. Returns a frame for containers.
  const put = (v: unknown, slotW: number, parent: Frame | null, key: string | number | undefined): Frame | null => {
    switch (typeof v) {
      case "boolean":
        setInlineSlot(out.u32, slotW, v ? T_TRUE : T_FALSE);
        return null;
      case "number":
        if (isInt32(v)) {
          setInlineSlot(out.u32, slotW, T_INT, v);
        } else {
          out.ensure(8);
          out.f64[out.pos / 8] = v;
          setOffsetSlot(out.u32, slotW, T_FLOAT, out.pos);
          out.pos += 8;
        }
        return null;
      case "string": {
        if (!v.isWellFormed()) reject("string contains a lone surrogate", parent, key);
        out.ensure(8 + v.length * 3 + 8);
        const at = out.pos;
        const len = out.buf.write(v, at + 8);
        out.u8[at] = T_STRING;
        out.u8[at + 1] = len === v.length ? STR_ASCII : 0;
        out.u32[at / 4 + 1] = len;
        setOffsetSlot(out.u32, slotW, T_STRING, at);
        out.pos = align8(at + 8 + len);
        return null;
      }
      case "object":
        break;
      default:
        reject(`unsupported value (${describe(v)})`, parent, key);
    }
    if (v === null) {
      setInlineSlot(out.u32, slotW, T_NULL);
      return null;
    }
    const proto = Object.getPrototypeOf(v);
    const isArray = Array.isArray(v);
    if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      reject(`unsupported value (${describe(v)})`, parent, key);
    }
    if (ancestors.has(v)) reject("cycle detected", parent, key);

    const frame: Frame = { value: v, isArray, keys: null, n: 0, i: 0, slotW: 0, parent, keyInParent: key };
    const at = out.pos;
    if (isArray) {
      const n = (v as unknown[]).length;
      out.ensure(8 + n * 8);
      const w = at / 4;
      out.u32[w] = T_ARRAY;
      out.u32[w + 1] = n;
      frame.n = n;
      frame.slotW = w + 2;
      out.pos = at + 8 + n * 8;
    } else {
      const keys = Object.keys(v);
      const n = keys.length;
      const idsW = n + (n & 1); // keyIds padded to 8 bytes
      out.ensure(8 + idsW * 4 + n * 8 + (n > SORT_THRESHOLD ? idsW * 4 : 0));
      const w = at / 4;
      const u32 = out.u32;
      u32[w] = T_OBJECT;
      u32[w + 1] = n;
      const ids = new Array<number>(n);
      for (let i = 0; i < n; i++) u32[w + 2 + i] = ids[i] = intern(keys[i], frame, keys[i]);
      frame.slotW = w + 2 + idsW;
      let end = frame.slotW + n * 2;
      if (n > SORT_THRESHOLD) {
        const perm = Array.from({ length: n }, (_, i) => i).sort((a, b) => ids[a] - ids[b]);
        for (let i = 0; i < n; i++) u32[end + i] = perm[i];
        end += idsW;
      }
      frame.keys = keys;
      frame.n = n;
      out.pos = end * 4;
    }
    setOffsetSlot(out.u32, slotW, isArray ? T_ARRAY : T_OBJECT, at);
    ancestors.add(v);
    return frame;
  };

  const rootFrame = put(root, H_ROOT / 4, null, undefined);
  if (rootFrame) stack.push(rootFrame);

  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    if (f.i === f.n) {
      stack.pop();
      ancestors.delete(f.value);
      continue;
    }
    const i = f.i++;
    let child: Frame | null;
    if (f.isArray) {
      const v = f.value[i];
      if (v === undefined && !(i in f.value)) reject("sparse array hole", f, i);
      child = put(v, f.slotW + i * 2, f, i);
    } else {
      const k = f.keys![i];
      child = put(f.value[k], f.slotW + i * 2, f, k);
    }
    if (child) stack.push(child);
  }

  // Key table: count u32, then per key byteLen u32 + utf8 bytes.
  const keyTableOffset = out.pos;
  out.ensure(4);
  out.buf.writeUInt32LE(keyList.length, out.pos);
  out.pos += 4;
  for (const k of keyList) {
    out.ensure(4 + k.length * 3);
    const len = out.buf.write(k, out.pos + 4);
    out.buf.writeUInt32LE(len, out.pos);
    out.pos += 4 + len;
  }
  const fileLength = align8(out.pos);
  out.ensure(fileLength - out.pos);

  const header = out.u32.subarray(H_ROOT / 4, H_ROOT / 4 + 2);
  writeHeader(new DataView(out.u8.buffer), {
    flags: 0,
    rootLo: header[0],
    rootHi: header[1],
    keyTableOffset,
    fileLength,
  });
  return out.buf.subarray(0, fileLength);
}
