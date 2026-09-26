# Tasks

## 1. Scaffolding

- [x] 1.1 Create the TypeScript ESM package (`package.json` name `nickle`, `engines.node >= 20`, `tsconfig.json`, `src/index.ts` exporting `write`, `open`, `materialize`) and verify `npm run build` emits `dist/index.js`
- [x] 1.2 Scaffold the Rust crate in `native/` with `@napi-rs/cli` (napi-rs + memmap2), and verify `npm run build:native` produces a loadable `.node` file for the host platform
- [x] 1.3 Add a `node:test` runner (`npm test`) and a `bench/` directory with the reference tree generator (seeded, ~2.9M nodes, 40 recurring keys), and verify `npm test` runs with zero tests and `node bench/gen.mjs` prints the node count

## 2. Performance spike (gate before the full build)

- [x] 2.1 Prototype a Proxy view over a hand-built buffer with a D3 key lookup, and verify with a benchmark that a property read costs under ~200 ns. Record the results in `bench/RESULTS.md`
- [x] 2.2 Benchmark ASCII string decode strategies (`fromCharCode` loop, `latin1`, `TextDecoder`) across lengths 1-256, and record the chosen length threshold in `bench/RESULTS.md`
- [x] 2.3 Prototype the materialize decoder on the reference tree, verify it beats `JSON.parse`, and record the result. If any spike misses its target, stop and revisit design.md before continuing

## 3. Format and writer (spec: cache-writing)

- [x] 3.1 Implement format constants, slot encoding and the header (`src/format.ts`, D2), and verify unit tests round-trip every slot type, including int32 edges, `-0` and `NaN`
- [x] 3.2 Implement the encoder: tree walk, key interning, `sortIdx` for nodes with more than 8 keys, and 8-byte alignment. Verify tests decode the produced buffer to the expected layout
- [x] 3.3 Implement validation with path-bearing `TypeError`s (unsupported types, `undefined`, cycles, sparse holes, lone surrogates, non-plain prototypes), and verify every cache-writing rejection scenario has a passing test
- [x] 3.4 Implement the atomic write (temp file, `fsync`, rename, cleanup on failure), and verify tests for "no file on failure" and "existing file intact on failure"
- [x] 3.5 Document `write()`, the supported types and the error format in `README.md`, and verify the README examples run as written

## 4. Native mapping (Rust)

- [x] 4.1 Implement `mapFile(path)`, returning an external ArrayBuffer over a read-only memmap2 mapping, with a finalizer-driven unmap. Verify a Rust unit test plus a JS test that reads the bytes of a known file
- [x] 4.2 Implement `unmap(buf)`: detach the ArrayBuffer, then unmap, idempotently. Verify a JS test that reading the buffer after unmap sees length 0 and the process does not crash
- [x] 4.3 Implement the loader in `src/native.ts`: native first, `readFileSync` fallback, honoring `NICKLE_NO_NATIVE=1`. Verify tests exercise both paths

## 5. Reader and views (spec: cache-reading)

- [x] 5.1 Implement `open()`: header and version checks, the truncation check against `fileLength`, and key table decoding. Verify tests for the `ENOENT`, `NICKLE_BAD_MAGIC`, `NICKLE_BAD_VERSION` and `NICKLE_TRUNCATED` scenarios
- [x] 5.2 Implement the object and array Proxy views (D4) with the `get`, `has`, `ownKeys` and `getOwnPropertyDescriptor` traps and the D5 string decoding. Verify the tests for nested reads, missing keys, `Array.isArray`, `length`, `for...of`, `Object.keys` and `JSON.stringify` all pass
- [x] 5.3 Implement the child view cache and the immutability traps. Verify tests for stable identity, and for assignment and delete throwing in both strict and sloppy mode
- [x] 5.4 Implement `materialize()` (D6) for views, the root and primitives. Verify the "materialized copy is plain" test and that the copies are mutable
- [x] 5.5 Implement `close()` with the closed-flag check (D7). Verify tests for `NICKLE_CLOSED` after close, materialized data surviving close, and a double close being a no-op
- [x] 5.6 Add round-trip property tests: random trees, write, then compare `materialize(open().root)` with the original. Verify 1,000 seeded cases pass in both native and fallback modes
- [x] 5.7 Document `open()`, views, `materialize()`, `close()` and the Proxy caveats (identity, `structuredClone`, Windows rename) in `README.md`, and verify the examples run

## 6. Integration and release readiness

- [x] 6.1 Add a two-process test: a writer loop against a reader that opens and materializes. Verify every read yields an intact tree, the snapshot-after-replace scenario passes on POSIX, and the test is skipped on Windows
- [x] 6.2 Run the benchmark suite (`npm run bench`) on the reference tree. Verify `open` takes under 5 ms with native, materialize beats `JSON.parse`, and lazy reads stay under ~200 ns, then record the numbers in `bench/RESULTS.md`
- [x] 6.3 Configure the napi-rs GitHub Actions matrix for the five target platforms, and verify a CI run builds every binary and passes `npm test` on each
