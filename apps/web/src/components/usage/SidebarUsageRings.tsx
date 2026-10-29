import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, remainingPercent } from "@t3tools/shared/usageLimits";

import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { selectSidebarLimit } from "./sidebarUsageLimits";

export function SidebarUsageRings() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const accounts = collectLimitAccounts(presentations);
  return (
    <span className="flex shrink-0 gap-1 pb-0.5 group-data-[collapsible=icon]:flex-col">
      {(["codex", "claudeAgent"] as const).map((driver) => {
        const window = selectSidebarLimit(accounts, driver, primaryEnvironmentId);
        const remaining = window ? remainingPercent(window) : null;
        const label =
          driver === "codex"
            ? "Codex weekly"
            : `Claude${window?.kind === "weekly" ? " weekly" : ""}`;
        return (
          <span
            key={driver}
            role="img"
            aria-label={`${label}: ${remaining === null ? "no data" : `${remaining}% left`}`}
            className="relative inline-flex size-7 items-center justify-center text-[9px] font-medium text-foreground tabular-nums"
          >
            <svg
              aria-hidden
              className="absolute inset-0 size-full -rotate-90"
              viewBox="0 0 28 28"
              fill="none"
            >
              <circle
                cx="14"
                cy="14"
                r="12"
                stroke="currentColor"
                strokeWidth="2"
                className="text-muted-foreground/20"
              />
              <circle
                cx="14"
                cy="14"
                r="12"
                pathLength="100"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeDasharray={`${remaining ?? 0} 100`}
                opacity={remaining === null || remaining === 0 ? 0 : 1}
                className={
                  driver === "codex"
                    ? "text-blue-500 dark:text-blue-400"
                    : "text-stone-500 dark:text-stone-400"
                }
              />
            </svg>
            <span aria-hidden>{remaining ?? "–"}</span>
          </span>
        );
      })}
    </span>
  );
}
