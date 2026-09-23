import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: false },
  },
});

export const queryKeys = {
  settings: ["settings"] as const,
  secretStatus: (name: string) => ["secret-status", name] as const,
  usage: ["llm-usage"] as const,
  recentCalls: ["llm-calls"] as const,
  dataPaths: ["data-paths"] as const,
};
