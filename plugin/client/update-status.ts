import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { updatesCheckRpc, updatesInstallRpc, type UpdatesCheckOutput, type UpdatesInstallOutput } from "../shared/contracts";
import { errorMessageOf } from "./errors";

export const UPDATE_STATUS_KEY = ["paseo-bm", "updates", "check"] as const;
const LOST_UPDATE_RESPONSE = "The update response was lost, so the active version is unknown. Run `paseo plugin ls`, then retry `paseo plugin update paseo-bm` if the installed version is still old.";

export function rejectedInstallResult(): UpdatesInstallOutput {
  return {
    outcome: "unknown",
    message: LOST_UPDATE_RESPONSE,
    command: "paseo plugin update paseo-bm",
    error: { code: "E_UPDATE_RESULT_UNKNOWN", message: LOST_UPDATE_RESPONSE },
  };
}

export interface UpdateStatusQuery {
  data: UpdatesCheckOutput | undefined;
  isPending: boolean;
  error: string | null;
  checking: boolean;
  checkNow: () => void;
  confirmingInstall: boolean;
  installing: boolean;
  installResult: UpdatesInstallOutput | null;
  requestInstall: () => void;
  cancelInstall: () => void;
  confirmInstall: () => void;
}

/** Cached automatic check plus the Settings-only forced refresh action. */
export function useUpdateStatus(): UpdateStatusQuery {
  const check = useRpc(updatesCheckRpc);
  const install = useRpc(updatesInstallRpc);
  const queryClient = useQueryClient();
  const [confirmingInstall, setConfirmingInstall] = useState(false);
  const [installResult, setInstallResult] = useState<UpdatesInstallOutput | null>(null);
  const query = useQuery({
    queryKey: UPDATE_STATUS_KEY,
    queryFn: () => check({ force: false }),
    retry: false,
  });
  const forced = useMutation({
    mutationFn: () => check({ force: true }),
    onSuccess: (data) => queryClient.setQueryData(UPDATE_STATUS_KEY, data),
  });
  const installing = useMutation({
    mutationFn: () => install({}),
    onMutate: () => setInstallResult(null),
    onSuccess: (data) => {
      setInstallResult(data);
      setConfirmingInstall(false);
    },
    onError: () => {
      setInstallResult(rejectedInstallResult());
      setConfirmingInstall(false);
    },
  });
  return {
    data: query.data,
    isPending: query.isPending,
    error: forced.isError ? errorMessageOf(forced.error) : query.isError ? errorMessageOf(query.error) : null,
    checking: forced.isPending,
    checkNow: () => forced.mutate(),
    confirmingInstall,
    installing: installing.isPending,
    installResult,
    requestInstall: () => setConfirmingInstall(true),
    cancelInstall: () => setConfirmingInstall(false),
    confirmInstall: () => installing.mutate(),
  };
}

export function updateCheckedText(checkedAt: string | null): string {
  if (checkedAt === null) return "Not checked yet";
  const date = new Date(checkedAt);
  return Number.isNaN(date.getTime()) ? `Checked ${checkedAt}` : `Checked ${date.toLocaleString()}`;
}
