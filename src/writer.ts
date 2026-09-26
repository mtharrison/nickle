// Atomic write (design D8): encode fully, then temp file -> fsync -> rename.

import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { encode } from "./encoder.js";
import type { Value } from "./index.js";

export function write(path: string, value: Value): void {
  // Validation happens during encoding, so an invalid value never touches the disk.
  const buf = encode(value);
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o644);
    for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off, buf.length - off, off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}
