import type { UsageProviderKind } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";
import { UsageLimitsSection } from "./UsageLimits";
import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, remainingPercent } from "@t3tools/shared/usageLimits";

import { usePrimarySettings } from "../../hooks/useSettings";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { selectSidebarLimit, sidebarLimitLabel, sidebarNoDataReason } from "./sidebarUsageLimits";

const NO_HIDDEN_PROVIDERS: ReadonlySet<UsageProviderKind> = new Set();

export function SidebarUsageRings() {
  const gt = useGT();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const [now, setNow] = useState(Date.now);
  const accounts = collectLimitAccounts(presentations);
  return (
    <span className="flex shrink-0 gap-1 pb-0.5 group-data-[collapsible=icon]:flex-col">
      {(["codex", "claudeAgent"] as const).map((driver) => {
        const window = selectSidebarLimit(accounts, driver, primaryEnvironmentId);
        const remaining = window ? remainingPercent(window) : null;
        const label = sidebarLimitLabel(
          accounts,
          driver,
          primaryEnvironmentId,
          timestampFormat,
          now,
          sidebarNoDataReason(presentations, driver, primaryEnvironmentId),
        );
        return (
          <Tooltip
            key={driver}
            onOpenChange={(open) => {
              if (open) setNow(Date.now());
            }}
          >
            <TooltipTrigger
              delay={0}
              render={
                <span
                  role="img"
                  aria-label={label}
                  tabIndex={0}
                  className="relative inline-flex size-7 items-center justify-center text-3xs font-medium text-foreground tabular-nums"
                />
              }
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
                  className={driver === "codex" ? "text-usage-codex" : "text-usage-claude"}
                />
              </svg>
              <span aria-hidden>{remaining ?? "–"}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">
              <div className="flex w-72 max-w-[calc(100vw-3rem)] min-w-0 flex-col gap-2 wrap-anywhere text-left">
                {!window ? (
                  <>
                    <span className="font-medium">
                      {gt("{provider} · no usage limit data yet", {
                        provider: driver === "codex" ? "Codex" : "Claude",
                      })}
                    </span>
                    <span>{sidebarNoDataReason(presentations, driver, primaryEnvironmentId)}</span>
                  </>
                ) : null}
                <UsageLimitsSection
                  selectedEnvironmentIds={null}
                  hiddenProviders={NO_HIDDEN_PROVIDERS}
                  now={now}
                  driver={driver}
                  compact
                />
              </div>
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}
