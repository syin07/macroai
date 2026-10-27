import type { QueryClient } from "@tanstack/react-query";

export async function endAccountSession(
  client: QueryClient,
  navigate = (path: string) => window.location.replace(path),
) {
  await client.cancelQueries();
  client.clear();
  // A document navigation also drops router snapshots and the browser auth client's in-memory session.
  navigate("/sign-in");
}
