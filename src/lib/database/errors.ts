// Database failures that should become a 500. The message carries only the operation and the Postgres /
// PostgREST error code, never error details: those can echo row values (meal names, item names), and
// meal text must not reach logs.
export class DatabaseError extends Error {
  constructor(
    readonly operation: string,
    readonly code: string | undefined,
  ) {
    super(`${operation} failed${code ? ` (${code})` : ""}`);
    this.name = "DatabaseError";
  }
}

export function dbError(operation: string, error: { code?: string } | null | undefined): DatabaseError {
  return new DatabaseError(operation, error?.code);
}
