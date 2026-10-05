import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { updatesCheckRpc, type UpdatesCheckOutput } from "../shared/contracts";
import { errorMessageOf } from "./errors";

export const UPDATE_STATUS_KEY = ["paseo-bm", "updates", "check"] as const;

export interface UpdateStatusQuery {
  data: UpdatesCheckOutput | undefined;
  isPending: boolean;
  error: string | null;
  checking: boolean;
  checkNow: () => void;
}

/** Cached automatic check plus the Settings-only forced refresh action. */
export function useUpdateStatus(): UpdateStatusQuery {
  const check = useRpc(updatesCheckRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => check({ force: false }),
    retry: false,
  });
  const forced = useMutation({
    mutationFn: () => check({ force: true }),
    onSuccess: (data) => queryClient.setQueryData(UPDATE_STATUS_KEY, data),
  });
  return {
    data: query.data,
    isPending: query.isPending,
    error: forced.isError ? errorMessageOf(forced.error) : query.isError ? errorMessageOf(query.error) : null,
    checking: forced.isPending,
    checkNow: () => forced.mutate(),
  };
}

export function updateCheckedText(checkedAt: string | null): string {
  if (checkedAt === null) return "Not checked yet";
  const date = new Date(checkedAt);
  return Number.isNaN(date.getTime()) ? `Checked ${checkedAt}` : `Checked ${date.toLocaleString()}`;
}
