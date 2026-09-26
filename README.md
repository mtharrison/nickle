<p align="center">
  <img src="https://raw.githubusercontent.com/mtharrison/nickle/main/assets/logo.svg" width="140" alt="nickle logo: a nickel coin with a lightning bolt">
</p>

<h1 align="center">nickle</h1>

<p align="center">
  Open huge JS object caches in about a millisecond.
  <br>
  <a href="https://github.com/mtharrison/nickle/actions/workflows/ci.yml"><img src="https://github.com/mtharrison/nickle/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/nickle"><img src="https://img.shields.io/npm/v/nickle" alt="npm"></a>
</p>

Caching a big object tree as JSON means paying for `JSON.parse` of the whole
thing on every start, even when you only need a corner of it. nickle writes the
tree to a binary file instead. Opening the file decodes nothing: you get a
read-only view, and only the parts you touch are decoded. When you need real
objects, `materialize()` decodes a subtree (or everything) faster than
`JSON.parse`.

| 2.9M-node tree, Apple M5 Pro               | Time      |
| ------------------------------------------ | --------- |
| `JSON.parse` of the whole tree             | 362 ms    |
| nickle `open()`                            | ~0.5 ms   |
| Read 10% of the tree lazily                | ~60 ms    |
| `materialize()` the whole tree             | 176 ms    |

It's a good fit when each run reads a small part of a large cache. If you read
everything every time, the gain is about 2x.

```bash
npm install nickle
```

Requires Node.js 20 or later. Files are memory-mapped by a native addon when
one is available for your platform, with a pure-JS fallback otherwise.

## Writing

```js
import { write } from "nickle";

write("cache.nkl", {
  users: [{ name: "alice", roles: ["admin"] }, { name: "bob", roles: [] }],
  updatedAt: 1727280000,
});
```

`write(path, value)` is synchronous. It encodes the whole value in memory,
writes it to a temp file in the same directory (`<path>.<pid>.<random>.tmp`),
`fsync`s it, then renames it over `path`. A reader opening `path` sees either
the complete old file or the complete new file, never a partial one. If writing
fails, the temp file is removed and any existing file at `path` is unchanged.

### Supported values

| Type             | Notes                                                             |
| ---------------- | ----------------------------------------------------------------- |
| plain objects    | Prototype must be `Object.prototype` or `null`. Key order is kept. |
| arrays           | Prototype must be `Array.prototype`. No holes.                    |
| `null`, booleans |                                                                   |
| numbers          | Bit-exact, including `-0`, `NaN`, `Infinity` and `-Infinity`.     |
| strings          | Any well-formed Unicode. Lone UTF-16 surrogates are rejected.     |

Nesting depth is unlimited. The root may be any supported value, including a
primitive.

Everything else is rejected: `undefined`, functions, symbols, BigInt, `Date`,
`Map`, `Set`, typed arrays, class instances (including `Array` subclasses) and
objects with any other prototype. Like `JSON.stringify`, only own enumerable
string keys are written; symbol-keyed properties are ignored.

An object reachable by more than one path is written once per path, so the
reader sees independent copies. A cycle is an error.

### Errors

Invalid values throw a `TypeError` before any file is touched. The message
names the problem and the property path to the offending value:

```js
import { write } from "nickle";

try {
  write("bad.nkl", { a: { b: [0, new Date()] } });
} catch (err) {
  console.log(err.message); // nickle: unsupported value (Date instance) at a.b[1]
}

const o = { name: "loop" };
o.self = o;
try {
  write("bad.nkl", o);
} catch (err) {
  console.log(err.message); // nickle: cycle detected at self
}
```

Paths use `.key` for identifier-like keys, `["key"]` for others, and `[i]` for
array indices. A problem with the root value itself is reported `at <root>`.
File system errors (for example `ENOENT` for a missing directory) are thrown
as-is.

## Reading

```js
import { write, open } from "nickle";

write("cache.nkl", { users: [{ name: "alice" }, { name: "bob" }] });

const handle = open("cache.nkl");
const { root } = handle;

console.log(root.users[1].name); // bob
console.log(Array.isArray(root.users), root.users.length); // true 2
console.log(Object.keys(root.users[0])); // [ 'name' ]
console.log(root.nope); // undefined
console.log(JSON.stringify(root)); // {"users":[{"name":"alice"},{"name":"bob"}]}

handle.close();
```

`open(path)` returns a handle `{ root, close() }`. Opening checks the header
and decodes the key table, and nothing else, so it costs the same for a 1 KB
file as for a 1 GB one.

`root` is the stored value. Leaves (strings, numbers, booleans, `null`) come
back as ordinary primitives. Objects and arrays come back as **views**:
read-only [Proxy](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Proxy)
objects that decode from the file only when a property is read. Views support
what you'd use on plain data:

- property and index reads, `in`, `Object.keys`, `Object.entries`, `for...in`
- `Array.isArray`, `length`, `for...of`, spread, and non-mutating array methods (`map`, `filter`, `slice`...)
- `JSON.stringify`

Missing keys and out-of-range indices return `undefined`. Reading the same
path twice returns the same view (`root.users === root.users`).

Views are immutable. Assigning, defining or deleting a property throws a
`TypeError`, in strict and sloppy code alike, and so do mutating array methods
such as `push` and `sort`:

```js
import { write, open } from "nickle";

write("cache.nkl", { users: [{ name: "alice" }] });
const { root } = open("cache.nkl");

try {
  root.users[0].name = "eve";
} catch (err) {
  console.log(err instanceof TypeError, root.users[0].name); // true alice
}
```

## Materialize

`materialize(value)` decodes a view, and everything under it, into plain,
mutable objects and arrays. Use it for hot loops that walk a subtree heavily,
or anywhere real objects are required. It is faster than `JSON.parse` of the
same data. Primitives and anything that isn't a view are returned unchanged.

```js
import { write, open, materialize } from "nickle";

write("cache.nkl", { users: [{ name: "alice" }, { name: "bob" }] });
const handle = open("cache.nkl");

const users = materialize(handle.root.users);
users.push({ name: "carol" });
handle.close();

console.log(users.map((u) => u.name).join(",")); // alice,bob,carol
```

## Closing

`close()` releases the file. After it, any access through a view from that
handle throws an `Error` with `code: "NICKLE_CLOSED"`. Values from
`materialize()` are independent of the handle and stay usable. Closing twice
does nothing.

```js
import { write, open, materialize } from "nickle";

write("cache.nkl", { users: [{ name: "alice" }] });
const handle = open("cache.nkl");
const users = handle.root.users;
const copy = materialize(users);
handle.close();

try {
  users[0];
} catch (err) {
  console.log(err.code); // NICKLE_CLOSED
}
console.log(copy[0].name); // alice
```

A handle that is never closed is released when it is garbage collected, but
that can happen late, so call `close()` when you're done, especially with big
files.

## Errors when opening

| `err.code`           | Meaning                                              |
| -------------------- | ---------------------------------------------------- |
| `ENOENT` (and other `fs` codes) | The file can't be opened.                 |
| `NICKLE_BAD_MAGIC`   | Not a nickle file.                                   |
| `NICKLE_BAD_VERSION` | Written by an incompatible format version.           |
| `NICKLE_TRUNCATED`   | Shorter than its header says: an incomplete copy.    |
| `NICKLE_CORRUPT`     | The header is valid but its key table is out of bounds. |

A nickle file is a disposable cache: on any of these, regenerate it.

## Native addon and fallback

On darwin-arm64, darwin-x64, linux-x64-gnu, linux-arm64-gnu and win32-x64-msvc,
a prebuilt native addon memory-maps the file, so `open()` doesn't read it.
Elsewhere, or with `NICKLE_NO_NATIVE=1` set, nickle reads the whole file into
memory at `open()` instead. Everything else behaves the same.

## Caveats

- **Views are not the objects you wrote.** A view is never `===` to a
  materialized copy or to the original value, and `structuredClone(view)`
  throws. Use `materialize()` first when you need real objects.
- **Snapshots on POSIX.** An open handle keeps reading the file as it was when
  opened, even after `write()` replaces it. A new `open()` sees the new file.
  Don't modify a cache file in place by other means while it's open: that can
  crash the process.
- **GC pause in large heaps.** V8 counts a mapped file as external memory.
  Opening a file of more than ~64 MB in a process that already holds a large
  heap can trigger a garbage collection during `open()` (measured ~9 ms, and
  up to ~50 ms, with a ~300 MB heap). In a fresh process, `open()` takes
  well under 5 ms.
- **Windows.** A file that is open can't be renamed over, so `write()` to a
  path with an open handle fails with the OS error. Close the handle first.
- **Depth.** `write()` and lazy views handle any nesting depth.
  `materialize()` and `JSON.stringify` recurse, and throw a `RangeError` on
  trees nested more than about 4,000 levels deep.

## Development

```bash
npm install
npm run build:native   # needs a Rust toolchain
npm test
npm run bench
```

Design notes, specs and benchmark results live in `openspec/` and
`bench/RESULTS.md`.

To release, bump the version with `npm version <patch|minor|major>`, then push
the tag with `git push --follow-tags`. The Release workflow builds the five
platform binaries, publishes `nickle-<platform>` packages and then `nickle`.
It needs an `NPM_TOKEN` repository secret.

## License

MIT
