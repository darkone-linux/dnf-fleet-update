// Outcome of a check on outside data or user input: expected failures are data.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });
