export type NickleCode = "NICKLE_BAD_MAGIC" | "NICKLE_BAD_VERSION" | "NICKLE_TRUNCATED" | "NICKLE_CORRUPT" | "NICKLE_CLOSED";

export class NickleError extends Error {
  readonly code: NickleCode;

  constructor(code: NickleCode, message: string) {
    super(`nickle: ${message}`);
    this.name = "NickleError";
    this.code = code;
  }
}
