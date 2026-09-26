import { useQuery, useQueryClient } from "@tanstack/react-query";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Effect } from "effect";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { type ReportRequest, Reports } from "@/services/report";

/** The last report written, or null before the first. */
export function useLastReport() {
  return useQuery({
    queryKey: queryKeys.report,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Reports, (r) => r.last),
        signal,
      ),
  });
}

/** Writes a report for the chosen period; the new one replaces the last on screen. */
export function useWriteReport() {
  const client = useQueryClient();
  return useAppMutation((req: ReportRequest) => Effect.flatMap(Reports, (r) => r.generate(req)), {
    onSuccess: (report) => client.setQueryData(queryKeys.report, report),
  });
}

/** Puts text on the clipboard. */
export function useCopy() {
  return useAppMutation((text: string) => Effect.tryPromise(() => writeText(text)), {
    success: "Copied",
  });
}
