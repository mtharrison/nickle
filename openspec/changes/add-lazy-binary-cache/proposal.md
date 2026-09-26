# Proposal

## Why

Caching large object trees as JSON is slow to load. On a 2.9M-node tree, `JSON.parse` takes ~451 ms, and `v8.serialize` is slower still (~527 ms). Just allocating the objects costs ~222 ms, so no eager format can beat JSON by more than ~2x. The large win comes from not decoding what isn't read. Callers here touch a varying fraction of the tree per run.

## What Changes

- New npm package `nickle` that writes a JS object tree (plain objects, arrays, primitive leaves) to a binary file.
- Opening a file returns a read-only, lazily decoded view of the tree. Open time does not grow with node count, and nodes are decoded only when accessed.
- `materialize()` eagerly converts any view (or the whole tree) into plain JS objects, for hot loops that walk a subtree heavily.
- A native Rust addon (napi-rs) memory-maps files, with a pure-JS fallback that reads the whole file into a Buffer when the addon is unavailable.
- Read-only in v1. Mutation, class instances, Map/Set/Date/BigInt and cyclic graphs are out of scope.

## Capabilities

### New Capabilities
- `cache-writing`: serializing a supported object tree to a binary cache file, including value validation, round-trip fidelity and atomic replacement.
- `cache-reading`: opening a cache file as lazy read-only views, materializing subtrees, file validation, and handle lifecycle.

### Modified Capabilities

None (greenfield project).

## Impact

- New codebase: TypeScript package plus a Rust native crate built with napi-rs.
- Dependencies: `napi-rs` toolchain and the `memmap2` crate on the Rust side. No runtime JS dependencies.
- Distribution: prebuilt native binaries per platform, published as optional npm packages.
- Requires Node.js 20 or later.
