// Loader (design D9): memory-map with the native addon when it loads, else
// read the whole file. NICKLE_NO_NATIVE=1 forces the fallback.

import { closeSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

interface Binding {
  mapFile(path: string): ArrayBuffer;
  unmap(buf: ArrayBuffer): void;
}

export interface Mapped {
  ab: ArrayBuffer;
  /** Detaches and unmaps (native) or drops nothing (fallback). */
  release(): void;
}

let binding: Binding | null | undefined;

function load(): Binding | null {
  if (binding === undefined) {
    binding = null;
    if (process.env.NICKLE_NO_NATIVE !== "1") {
      try {
        binding = createRequire(import.meta.url)("../native/index.cjs") as Binding;
      } catch {}
    }
  }
  return binding;
}

export function mode(): "native" | "fallback" {
  return load() ? "native" : "fallback";
}

export function mapFile(path: string): Mapped {
  const b = load();
  if (b) {
    let ab: ArrayBuffer;
    try {
      ab = b.mapFile(path);
    } catch (err) {
      // Surface the usual Node error (ENOENT, EACCES, EISDIR...) when there is one.
      closeSync(openSync(path, "r"));
      throw err;
    }
    return { ab, release: () => b.unmap(ab) };
  }
  const buf = readFileSync(path);
  // Typed-array views need an 8-byte-aligned, exclusively owned buffer.
  const ab = buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength
    ? (buf.buffer as ArrayBuffer)
    : new Uint8Array(buf).buffer;
  return { ab, release() {} };
}
