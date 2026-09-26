# Design

## Context

Greenfield. See proposal.md (Why) for the benchmark numbers that motivate lazy reading. Two measured constraints shape everything below:

- **Allocation floor.** Building 2.9M JS objects costs ~222 ms even with zero decoding. Eager decoders cannot beat JSON by more than ~2x.
- **JS to native crossings cost ~20-100 ns each** (N-API, Node's C interface for native addons). Per-node work in this format is smaller than that, so any per-node call into Rust is a net loss.

## Goals / Non-Goals

**Goals:**
- O(1) (constant-time) navigation from a container to any child: no scanning past siblings.
- Lazy access costs no more than ~200 ns per property read.
- Materialize runs close to the allocation floor.

**Non-Goals:**
- Async API (writing is CPU-bound; v1 is synchronous only).
- Compression, checksums, schema evolution, and cross-language readers.
- Big-endian hosts (the format is little-endian; the addon refuses to load elsewhere).

## Decisions

### D1. Split: Rust maps the file, JS does everything per node

```
+------- Rust (napi-rs) --------+        +----------------- JS / TypeScript ----------------+
| mapFile(path)                 |        | write(): walk tree -> encode into Buffer         |
|   memmap2 read-only mapping   |------->|          -> temp file -> fsync -> rename         |
|   -> external ArrayBuffer     |  once  | open():  header + key table -> root view         |
| unmap(buf)                    |        | views:   Proxy traps read DataView over buffer   |
|   detach ArrayBuffer, unmap   |        | materialize(): recursive decoder over buffer     |
+-------------------------------+        +--------------------------------------------------+
```

The external ArrayBuffer wraps memory that Rust owns: JS reads the mapped bytes directly, with no copy. Writing stays in JS: Node's `fs` already provides `fsync` and `rename`, so Rust would add a crossing for nothing.
*Alternatives:* a Rust reader behind thin bindings (per-access crossings make it several times slower), or WASM (same boundary cost, and no mmap).

### D2. File format (little-endian, 8-byte aligned)

```
+--------------------------------------------------------------+
| HEADER (32 B)                                                |
|  magic "NKL\0" | version u16 | flags u16 | root slot (8 B)   |
|  keyTableOffset u64 | fileLength u64                         |
+--------------------------------------------------------------+
| NODE AREA                                                    |
|  OBJECT: tag u8 | count u32 | pad                            |
|          keyIds u32[count]         (insertion order)         |
|          slots  u64[count]         (insertion order)         |
|          sortIdx u32[count]        (only when count > 8)     |
|  ARRAY:  tag u8 | length u32 | pad | slots u64[length]       |
|  STRING: tag u8 | flags(ascii) | byteLen u32 | utf8 bytes    |
|  FLOAT:  f64                                                 |
+--------------------------------------------------------------+
| KEY TABLE: count u32 | per key: byteLen u32 + utf8 bytes     |
+--------------------------------------------------------------+
```

A **slot** is 8 bytes: a 3-bit type tag plus a payload. `null`, booleans and int32 values are stored inline; strings, floats and containers store an offset. Fixed-width slots make array indexing O(1).

Keys are interned: each distinct key is stored once and referenced by a u32 id. `fileLength` in the header is how truncation is detected (`NICKLE_TRUNCATED`).

*Alternatives:* MessagePack or CBOR (variable-width encodings, so reaching a child means scanning its siblings), or FlatBuffers (needs a schema).

### D3. Key lookup inside an object

On open, the key table is decoded into a `Map<string, id>`, which is O(distinct keys). A property read maps the name to an id, then:

- `count <= 8`: linear scan over `keyIds`
- otherwise: binary search over the `sortIdx` permutation

Insertion order is kept in the main arrays for enumeration. A name missing from the key table returns `undefined` without touching the node.

*Alternative:* a per-node hash table. It's faster for very wide nodes but costs space; revisit if benchmarks show wide nodes.

### D4. Views are Proxies with a real target

Each container view is a `Proxy` over an empty target: `[]` for arrays, so `Array.isArray` is true, and a plain `{}` for objects. The `get`, `has`, `ownKeys` and `getOwnPropertyDescriptor` traps decode from the buffer. The `set`, `defineProperty` and `deleteProperty` traps throw `TypeError`.

Proxy invariants require an array target's `length` to be reported consistently. The target is therefore created with `length` set to the real length, a cheap sparse allocation.

Child views are cached per parent in a `Map<slotIndex, view>`, which provides stable identity.
*Alternative:* generated getter classes per object shape. They're faster, but shapes vary in this data, which would make the classes megamorphic: too many shapes for V8's inline caches to optimize.

### D5. Strings

A flag marks pure-ASCII strings. These are decoded with a JS loop and `String.fromCharCode` for short strings, and with `latin1` Buffer decoding for longer ones. Non-ASCII strings use `TextDecoder`. Decoded leaf strings are not cached, which keeps memory bounded. The key table is decoded once.

### D6. Materialize

A recursive decoder reads directly from the buffer, bypassing Proxies. It builds object literals by assigning keys in stored order, so objects with the same shape share V8 hidden classes (the internal layouts V8 uses to make property access fast). Called on a view, it starts at that view's offset.

### D7. Close and lifetime

`close()` calls the native `unmap`. That detaches the ArrayBuffer (`napi_detach_arraybuffer`), then unmaps it. Detached buffers have length 0, so any later read is caught by a closed-flag check and throws `NICKLE_CLOSED` instead of faulting.

A handle that is never closed is unmapped by a finalizer: the external buffer's cleanup callback, which runs when the garbage collector frees it. In fallback mode, `close()` just drops the Buffer reference.

### D8. Atomic write

The writer encodes into a single growable Buffer, writes it to `<path>.<pid>.<random>.tmp` in the same directory, calls `fsync`, then renames the temp file over the target. On failure, the temp file is removed. Validation happens during encoding, before any file I/O, so an invalid value never touches the disk.

### D9. Packaging

The layout is a TypeScript ESM package (`src/`) plus a Rust crate (`native/`) built with `@napi-rs/cli`. Prebuilt binaries ship as optional dependencies for darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu and win32-x64-msvc.

The loader tries the native binding, falls back to `fs.readFileSync` on failure, and honors `NICKLE_NO_NATIVE=1`. Tests use `node:test`.

### Public API

```ts
write(path: string, value: Value): void
open(path: string): { root: Value; close(): void }
materialize<T>(value: T): T
type Value = null | boolean | number | string | Value[] | { [k: string]: Value }
```

## Risks / Trade-offs

- [Proxy trap cost exceeds ~200 ns] -> Spike first (task group 2). If it's too slow, reduce per-trap work: the key-to-id lookup and a monomorphic fast path.
- [ASCII decode path slower than hoped for short strings] -> Benchmark three strategies during the spike and pick per length threshold.
- [Materialize doesn't beat `JSON.parse`] -> This is a spec requirement, so it's verified by benchmark. Levers: pre-decoded key strings, a stable key order, and avoiding closures in the decoder.
- [Windows can't rename over a file that's mapped open] -> The atomic-replace guarantee is POSIX-only in v1. On Windows, a write fails with the OS error while a handle is open. Documented.
- [A finalizer runs late on big files] -> Document that `close()` is recommended.
- [V8 counts the mapped file as external memory] -> A mapping of more than ~64 MB can make V8 run a garbage collection inside `open`, which costs time in proportion to the caller's heap (measured ~9 ms, and up to ~50 ms, with a ~300 MB heap). `open` itself stays ~0.25 ms. The 5 ms bound applies to a fresh process, and the pause is documented. Offsetting the count with `napi_adjust_external_memory` was tried and rejected: V8 aborts if the counter goes negative. Revisit with chunked mapping if callers report pauses.
- [Proxy edge cases: `===` against materialized copies, `structuredClone(view)` fails] -> Document them, and point users to `materialize` for those cases.

## Migration Plan

Not applicable (new package). The format version starts at 1. Readers reject other versions, and callers treat the file as a disposable cache that can be regenerated.
