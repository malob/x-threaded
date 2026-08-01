import { QueryClient } from "@tanstack/react-query";

/**
 * The cache is configured to never fetch on its own.
 *
 * Reading X costs about half a cent per post and the server bills the moment a
 * request reaches it, so every default here is a deliberate "only when asked":
 *
 * - `staleTime: Infinity` — cached data never ages into staleness, so nothing
 *   inside the library ever decides on its own that a refetch is due.
 * - the three `refetchOn*` flags — a window regaining focus, a laptop waking
 *   from sleep, or a component remounting are not requests to re-read a
 *   conversation, and each of them would be a real charge.
 * - `retry: false` on queries *and* mutations — the server already retries the
 *   X calls where retrying is safe. A client retry re-sends a request that may
 *   well have billed before it failed, so it buys the same posts twice.
 *
 * Endpoints that cost nothing opt back in individually (see `inbox.ts`). The
 * default has to be the safe one, because the next query someone adds without
 * thinking about money inherits it.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchOnMount: false,
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}
