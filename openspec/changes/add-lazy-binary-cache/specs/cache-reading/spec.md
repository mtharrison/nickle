# Spec Delta

## Purpose

Opens a binary cache file as lazily decoded, read-only views of the stored tree, with on-demand eager materialization of any subtree.

## ADDED Requirements

### Requirement: Open time independent of node count
Opening a cache file SHALL NOT decode the tree's nodes. Open time SHALL be proportional to the number of distinct object keys in the file, not to the number of nodes or the file size.

#### Scenario: Large file opens quickly
- **WHEN** the caller opens a file holding the reference benchmark tree (~2.9M nodes, ~71 MB) as the first `open` in a fresh process
- **THEN** `open` returns in under 5 ms on the reference machine, with the native addon loaded

#### Scenario: Garbage collection may add a pause in a large heap
- **WHEN** the caller opens a large file in a process that already holds a large heap
- **THEN** `open` may take longer because V8 can run a garbage collection in response to the mapped file's size, and this behavior is documented

### Requirement: Views behave like read-only plain values
Accessing the root or any nested container SHALL return a view. Views of objects SHALL support property reads, the `in` operator, `Object.keys`, `Object.entries`, `for...in`, and `JSON.stringify`. Views of arrays SHALL additionally report `Array.isArray(view) === true`, a correct `length`, index access, and iteration with `for...of`. Leaf values SHALL be returned as JS primitives. Missing keys and out-of-range indices SHALL return `undefined`.

#### Scenario: Nested read returns primitive
- **WHEN** a file holds `{ users: [{ name: "alice" }, { name: "bob" }] }` and the caller reads `root.users[1].name`
- **THEN** the result is the string `"bob"`

#### Scenario: Array view is an array
- **WHEN** the caller reads `root.users`
- **THEN** `Array.isArray(root.users)` is `true` and `root.users.length` is `2`

#### Scenario: Enumeration matches the original
- **WHEN** the caller calls `Object.keys(root.users[0])`
- **THEN** the result is `["name"]`

#### Scenario: JSON.stringify of a view
- **WHEN** the caller calls `JSON.stringify(root)`
- **THEN** the result equals `JSON.stringify` of the originally written value

#### Scenario: Missing key
- **WHEN** the caller reads `root.nope`
- **THEN** the result is `undefined`

### Requirement: View identity is stable
Reading the same container path twice from the same open handle SHALL return the identical view object.

#### Scenario: Repeated access is identical
- **WHEN** the caller reads `root.users` twice
- **THEN** the two results are `===`

### Requirement: Views are immutable
Any attempt to set, define or delete a property on a view MUST throw a `TypeError`, in both strict and sloppy mode, and MUST NOT change the view or the file.

#### Scenario: Assignment throws
- **WHEN** the caller executes `root.users[0].name = "eve"`
- **THEN** a `TypeError` is thrown and `root.users[0].name` is still `"alice"`

#### Scenario: Delete throws
- **WHEN** the caller executes `delete root.users`
- **THEN** a `TypeError` is thrown

### Requirement: Materialize a subtree
`materialize(value)` SHALL return a deep, mutable copy of a view as plain objects and arrays, with no views inside it. Passing a primitive SHALL return it unchanged. Materializing the whole reference benchmark tree SHALL be faster than `JSON.parse` of the equivalent JSON on the reference machine.

#### Scenario: Materialized copy is plain
- **WHEN** the caller calls `materialize(root.users)`
- **THEN** the result is a plain array of plain objects, deep-equal to the original, and can be modified without error

#### Scenario: Materialize beats JSON.parse
- **WHEN** the benchmark materializes the whole reference tree and separately runs `JSON.parse` on its JSON form
- **THEN** the materialize time is lower than the `JSON.parse` time

### Requirement: Invalid files are rejected
Opening a file that is missing, not a cache file, from an unsupported format version, or truncated MUST throw an `Error` with a `code` property of `ENOENT`, `NICKLE_BAD_MAGIC`, `NICKLE_BAD_VERSION` or `NICKLE_TRUNCATED` respectively.

#### Scenario: Not a cache file
- **WHEN** the caller opens a JSON text file
- **THEN** an error with code `NICKLE_BAD_MAGIC` is thrown

#### Scenario: Truncated file
- **WHEN** the caller opens a cache file cut to half its length
- **THEN** an error with code `NICKLE_TRUNCATED` is thrown

### Requirement: Handle lifecycle
`open` SHALL return a handle exposing `root` and `close()`. After `close()`, any access through a view from that handle MUST throw an `Error` with code `NICKLE_CLOSED`, and MUST NOT crash the process. Values previously returned by `materialize` SHALL remain usable. Calling `close()` twice SHALL be a no-op.

#### Scenario: Access after close
- **WHEN** the caller holds `const u = handle.root.users`, calls `handle.close()`, then reads `u[0]`
- **THEN** an error with code `NICKLE_CLOSED` is thrown and the process keeps running

#### Scenario: Materialized data survives close
- **WHEN** the caller materializes `root.users`, closes the handle, then reads the materialized array
- **THEN** the read succeeds

### Requirement: Open handles keep a stable snapshot
On POSIX systems, an open handle SHALL continue to read the file contents as they were at open time after the path is atomically replaced by a new write.

#### Scenario: Replaced file does not affect open handle
- **WHEN** a handle is open on a path and a different tree is then written to the same path
- **THEN** the open handle still reads the original tree, and a new `open` reads the new tree

### Requirement: Works without the native addon
When the native addon cannot be loaded, the package SHALL fall back to reading the file into memory and SHALL meet every requirement in this spec except the open-time bound.

#### Scenario: Fallback mode
- **WHEN** the native addon is disabled via the `NICKLE_NO_NATIVE=1` environment variable
- **THEN** all cache-reading scenarios except "Large file opens quickly" pass
