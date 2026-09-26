export type Value = null | boolean | number | string | Value[] | { [k: string]: Value };

export { write } from "./writer.js";
export { open, materialize, type Handle } from "./reader.js";
export { NickleError, type NickleCode } from "./errors.js";
