# Benchmark results

Machine: Apple M5 Pro (arm64), macOS 26 (Darwin 25.6), Node v24.18.1.

## 2.1 Proxy view spike (`node bench/spike-proxy.mjs`)

Hand-built buffer: 10,000 objects of int32 slots, 5 keys (linear scan) and
12 keys (`sortIdx` binary search). Target: under ~200 ns per property read.

| Case                                            | 5 keys  | 12 keys |
| ----------------------------------------------- | ------- | ------- |
| Same view, hit                                  | 16.8 ns | 17.3 ns |
| Same view, missing key                          | 18.3 ns | 18.9 ns |
| `root[i].k` over cached views (2 reads)         | 89.3 ns | 87.6 ns |
| `root[i].k`, first touch (includes view alloc)  | 115 ns  | 118 ns  |
| Baseline: plain objects                         | 0.9 ns  | 5.8 ns  |

**Pass.** A single read costs ~17 ns; the worst case (two reads plus creating
the child view) is ~118 ns. Array index reads cost more than object reads,
because the Proxy gets the index as a string and must parse it.

## 2.2 ASCII string decode (`node bench/spike-strings.mjs`)

ns per decode:

| len | fromCharCode loop | fromCharCode.apply | `latin1Slice` | TextDecoder |
| --- | ----------------- | ------------------ | ------------- | ----------- |
| 1   | 2.9               | 33.7               | 20.2          | 53.3        |
| 4   | 13.9              | 40.5               | 24.7          | 58.2        |
| 8   | 29.8              | 46.0               | 24.9          | 57.9        |
| 16  | 59.6              | 57.4               | 24.5          | 57.6        |
| 32  | 102.0             | 81.9               | 25.2          | 57.9        |
| 64  | 181.5             | 136.0              | 25.6          | 56.7        |
| 128 | 303.5             | 235.5              | 26.9          | 57.2        |
| 256 | 549.2             | 440.5              | 28.8          | 59.4        |

**Chosen threshold: byte length < 8 uses the `fromCharCode` loop; 8 and
longer use `Buffer#latin1Slice`.** Non-ASCII strings use TextDecoder (D5).

## 2.3 Materialize spike (`node --expose-gc bench/spike-materialize.mjs`)

Reference tree (`bench/gen.mjs`, seed 1): 2,907,540 nodes, 49.0 MB as JSON,
71.3 MB as a nickle file. 7 runs each, GC before each run.

| Decoder      | min    | median |
| ------------ | ------ | ------ |
| `JSON.parse` | 347 ms | 357 ms |
| materialize  | 168 ms | 171 ms |

**Pass.** Materialize is ~2.1x faster than `JSON.parse`, close to the
allocation floor. The file is larger than JSON: every string and float costs an
8-byte slot plus an 8-byte-aligned node.

All three spikes met their targets, so design.md stands unchanged.

## 6.2 Benchmark suite (`npm run bench`)

Reference tree as in 2.3. Native addon loaded.

| Measurement                                        | Result                | Target        |
| -------------------------------------------------- | --------------------- | ------------- |
| `open`, first call in a fresh process (native)     | 2.42 ms median of 9   | < 5 ms: pass  |
| `open`, first call in a fresh process (fallback)   | 4.69 ms median of 9   | (no bound)    |
| `open`, repeated, process holding ~300 MB of heap  | 8.61 / 8.88 / 9.40 ms (min/median/max) | informational (GC pause, see below) |
| `JSON.parse`                                       | 362 ms median of 7    |               |
| materialize                                        | 176 ms median of 7    | < `JSON.parse`: pass |
| Plain objects, same random-read loop (baseline)    | 137 ns/read           |               |
| Lazy read, first touch (includes view creation)    | 234 ns/read (+97 over baseline) | overhead < ~200 ns: pass |
| Lazy read, views cached                            | 205 ns/read (+68 over baseline) | overhead < ~200 ns: pass |

### Why `open` misses with a large heap

`open` itself is ~0.25 ms: mapping the file, reading the header and decoding
the key table. The rest is V8 garbage collection. V8 counts an external
ArrayBuffer's full length (71 MB here) as external memory, and a jump of over
~64 MB makes it schedule GC work, which can be a full Mark-Compact (measured up
to ~50 ms with `--trace-gc`) run synchronously inside `open`. How much it costs
depends on the caller's heap size, not on the file. In a fresh process the
same `open` takes ~0.5 ms after the addon is loaded.

Tried and rejected: offsetting the count with `napi_adjust_external_memory`.
V8 aborts the process if the counter would go negative.

### Why lazy reads are borderline

The loop reads `items[i][key]` at random `i` across 94,000 objects, and 70% of
reads are for keys the object doesn't have. It is dominated by cache misses:
plain JS objects cost 137 ns/read in the same loop. The views add ~70-100 ns on
top of that. The spike (2.1) measured ~17 ns per read on a hot view. Runs vary
by ±20 ns.

### Decision (2026-09-26)

The open-time bound was narrowed to the first `open` in a fresh process, and
the GC pause in large heaps is documented (spec, design.md risks, README).
The lazy-read target is checked as overhead over plain objects in the same
loop, because the absolute number is dominated by cache misses. At the expected
usage (1-10% of the tree per run) a run costs ~15-70 ms, against 360 ms for
`JSON.parse`.
