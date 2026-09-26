# Spec Delta

## Purpose

Serializes a JavaScript object tree with primitive leaves into a binary cache file that can later be opened lazily.

## ADDED Requirements

### Requirement: Supported value types
The writer SHALL accept a value made of plain objects, arrays, `null`, booleans, numbers and strings, nested to any depth. The root MAY be any supported value, including a primitive.

#### Scenario: Nested tree is written
- **WHEN** the caller writes `{ a: [1, "x", true, null], b: { c: 2.5 } }` to a path
- **THEN** the call succeeds and a cache file exists at that path

#### Scenario: Primitive root is written
- **WHEN** the caller writes the string `"hello"` as the root value
- **THEN** the call succeeds and reading the file back yields `"hello"`

### Requirement: Unsupported values are rejected
The writer MUST reject any value that is not a supported type, including `undefined`, functions, symbols, BigInt, class instances, Map, Set, Date, typed arrays, and objects with a non-`Object.prototype`, non-null prototype. The error SHALL be a `TypeError` whose message includes the property path to the offending value. No file SHALL be created or replaced when writing fails.

#### Scenario: Nested Date is rejected with its path
- **WHEN** the caller writes `{ a: { b: [0, new Date()] } }`
- **THEN** the writer throws a `TypeError` whose message contains `a.b[1]`
- **AND** no file exists at the target path

#### Scenario: Undefined property is rejected
- **WHEN** the caller writes `{ a: undefined }`
- **THEN** the writer throws a `TypeError` whose message contains `a`

#### Scenario: Failed write leaves existing file intact
- **WHEN** a valid cache file already exists at the path and the caller writes a value containing a function
- **THEN** the writer throws and the existing file is unchanged

### Requirement: Cycles are rejected and shared references are duplicated
The writer MUST throw a `TypeError` when the value contains a cycle. An object reachable through more than one path without a cycle SHALL be written once per path, so the reader sees independent copies.

#### Scenario: Cycle is rejected
- **WHEN** the caller writes an object `o` where `o.self === o`
- **THEN** the writer throws a `TypeError` whose message mentions a cycle and contains `self`

#### Scenario: Shared reference is written twice
- **WHEN** the caller writes `{ x: s, y: s }` where `s = { v: 1 }`
- **THEN** reading back yields `x` and `y` with equal contents

### Requirement: Round-trip fidelity
Reading a written file SHALL reproduce the value exactly: object key order, array length and order, string contents including non-ASCII Unicode, and numbers bit-for-bit, including `-0`, `NaN`, `Infinity` and `-Infinity`. Sparse array holes and strings (keys or values) containing lone UTF-16 surrogates MUST be rejected as unsupported.

#### Scenario: Key order preserved
- **WHEN** the caller writes `{ z: 1, a: 2, m: 3 }` and reads it back
- **THEN** `Object.keys` of the result is `["z", "a", "m"]`

#### Scenario: Special numbers preserved
- **WHEN** the caller writes `[-0, NaN, Infinity, -Infinity, 2**53 - 1, 0.1]` and reads it back
- **THEN** each element is identical under `Object.is` to the original

#### Scenario: Unicode strings preserved
- **WHEN** the caller writes `{ "ключ": "emoji 🎉 and 中文" }` and reads it back
- **THEN** the key and value are equal to the originals

#### Scenario: Sparse array rejected
- **WHEN** the caller writes `[1, , 3]`
- **THEN** the writer throws a `TypeError` whose message contains `[1]`

#### Scenario: Lone surrogate rejected
- **WHEN** the caller writes `{ s: "\uD800" }`
- **THEN** the writer throws a `TypeError` whose message contains `s`

### Requirement: Atomic replacement
Writing to a path SHALL replace any existing file atomically. A concurrent reader opening the path SHALL see either the complete old file or the complete new file, never a partial one.

#### Scenario: Reader never sees partial file
- **WHEN** one process repeatedly writes large trees to a path while another repeatedly opens and fully materializes it
- **THEN** every open succeeds and yields one of the written trees intact
