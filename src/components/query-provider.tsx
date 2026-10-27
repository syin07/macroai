"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { ApiClientError } from "@/lib/api/client";
import { MealUndoNotices } from "@/components/meals/meal-actions";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (count, error) =>
              count < 2 &&
              (!(error instanceof ApiClientError) || error.retryable),
          },
          mutations: { retry: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <MealUndoNotices />
    </QueryClientProvider>
  );
}
