import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Ctx } from "../dist/decode.js";
import { readHeader } from "../dist/format.js";

/** Parses an encoded buffer without going through open(). */
export function parse(buf) {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const dv = new DataView(ab);
  const header = readHeader(dv);
  const keys = [];
  let p = header.keyTableOffset + 4;
  for (let i = 0, n = dv.getUint32(header.keyTableOffset, true); i < n; i++) {
    const len = dv.getUint32(p, true);
    keys.push(Buffer.from(ab, p + 4, len).toString("utf8"));
    p += 4 + len;
  }
  return { ctx: new Ctx(ab, keys), header, dv, keys };
}

/** A temp directory removed after the test file finishes. */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "nickle-test-"));
  after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Windows can't delete files that are still mapped by unclosed handles.
      if (process.platform !== "win32") throw err;
    }
  });
  return dir;
}
