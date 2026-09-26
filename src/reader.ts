// open(), materialize() and close() (design D2, D6, D7).

import { Ctx, materializeArray, materializeObject, materializeSlot } from "./decode.js";
import { NickleError } from "./errors.js";
import { HEADER_SIZE, MAGIC, T_ARRAY, T_OBJECT, VERSION, readHeader } from "./format.js";
import { mapFile } from "./native.js";
import { arrayView, handlerOf, objectView } from "./views.js";
import type { Value } from "./index.js";

export interface Handle {
  readonly root: Value;
  close(): void;
}

const MAGIC_BYTES = [0x4e, 0x4b, 0x4c, 0x00]; // "NKL\0"
const td = new TextDecoder();

function checkHeader(ab: ArrayBuffer): ReturnType<typeof readHeader> {
  const u8 = new Uint8Array(ab);
  if (u8.length < HEADER_SIZE) {
    const prefix = MAGIC_BYTES.slice(0, u8.length).every((b, i) => u8[i] === b);
    if (prefix && u8.length > 0) throw new NickleError("NICKLE_TRUNCATED", `file is ${u8.length} bytes, shorter than the header`);
    throw new NickleError("NICKLE_BAD_MAGIC", "not a nickle cache file");
  }
  const h = readHeader(new DataView(ab));
  if (h.magic !== MAGIC) throw new NickleError("NICKLE_BAD_MAGIC", "not a nickle cache file");
  if (h.version !== VERSION) {
    throw new NickleError("NICKLE_BAD_VERSION", `unsupported format version ${h.version} (expected ${VERSION})`);
  }
  if (ab.byteLength < h.fileLength) {
    throw new NickleError("NICKLE_TRUNCATED", `file is ${ab.byteLength} bytes, header says ${h.fileLength}`);
  }
  return h;
}

function readKeys(ab: ArrayBuffer, off: number, end: number): string[] {
  const dv = new DataView(ab);
  const u8 = new Uint8Array(ab);
  const corrupt = () => new NickleError("NICKLE_CORRUPT", "key table is out of bounds");
  if (off < HEADER_SIZE || off + 4 > end) throw corrupt();
  const n = dv.getUint32(off, true);
  const keys = new Array<string>(n);
  let p = off + 4;
  for (let i = 0; i < n; i++) {
    if (p + 4 > end) throw corrupt();
    const len = dv.getUint32(p, true);
    if (p + 4 + len > end) throw corrupt();
    keys[i] = td.decode(u8.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return keys;
}

export function open(path: string): Handle {
  const mapped = mapFile(path);
  let ctx: Ctx;
  let root: Value;
  try {
    const h = checkHeader(mapped.ab);
    ctx = new Ctx(mapped.ab, readKeys(mapped.ab, h.keyTableOffset, h.fileLength));
    const tag = h.rootLo & 7;
    const w = (h.rootLo & ~7) >>> 2;
    root = (tag === T_OBJECT ? objectView(ctx, w + h.rootHi * 2 ** 30)
      : tag === T_ARRAY ? arrayView(ctx, w + h.rootHi * 2 ** 30)
      : materializeSlot(ctx, h.rootLo, h.rootHi)) as Value;
  } catch (err) {
    mapped.release();
    throw err;
  }
  return {
    root,
    close() {
      if (ctx.closed) return;
      ctx.closed = true;
      mapped.release();
      // Drop our references so a fallback-mode buffer can be collected.
      const empty = new ArrayBuffer(0);
      ctx.u8 = new Uint8Array(empty);
      ctx.u32 = new Uint32Array(empty);
      ctx.f64 = new Float64Array(empty);
      ctx.buf = Buffer.from(empty) as Ctx["buf"];
    },
  };
}

export function materialize<T>(value: T): T {
  const h = handlerOf(value);
  if (h === undefined) return value;
  return (h.isArray ? materializeArray(h.ctx, h.w) : materializeObject(h.ctx, h.w)) as T;
}
