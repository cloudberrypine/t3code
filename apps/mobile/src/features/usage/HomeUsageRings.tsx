import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, remainingPercent } from "@t3tools/shared/usageLimits";
import { selectSidebarLimit, sidebarNoDataReason } from "@t3tools/shared/sidebarUsageLimits";
import { formatLimitResetCountdown } from "@t3tools/shared/usageLimitFormatting";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { environmentPresentations } from "../../state/presentation";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { AccountLimits } from "./UsageLimitsSection";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Reads the same live config snapshots as the desktop sidebar, including hub accounts. */
export function HomeUsageRings() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const accounts = collectLimitAccounts(presentations);
  const [selection, setSelection] = useState<{
    driver: "codex" | "claudeAgent";
    now: number;
  } | null>(null);
  const { themeAppearance } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  return (
    <View style={{ flexDirection: "row" }}>
      {(["codex", "claudeAgent"] as const).map((driver) => {
        const window = selectSidebarLimit(accounts, driver, null);
        const remaining = window ? remainingPercent(window) : null;
        const label = driver === "codex" ? "OpenAI" : "Claude";
        const color =
          driver === "codex"
            ? themeAppearance === "dark"
              ? "#e6e6e6"
              : "#3c3c43"
            : themeAppearance === "dark"
              ? "#d97757"
              : "#b85e40";
        return (
          <Pressable
            key={driver}
            accessibilityRole="button"
            accessibilityLabel={`${label} usage, ${remaining === null ? "unavailable" : `${remaining}% left`}`}
            accessibilityHint="Shows usage limits and reset times"
            onPress={() => setSelection({ driver, now: Date.now() })}
            style={{ width: 40, height: 44, alignItems: "center", justifyContent: "center" }}
          >
            <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
              <Svg width={28} height={28} style={{ position: "absolute" }} viewBox="0 0 28 28">
                <Circle
                  cx={14}
                  cy={14}
                  r={12}
                  fill="none"
                  stroke={color}
                  strokeOpacity={0.2}
                  strokeWidth={2}
                />
                <Circle
                  cx={14}
                  cy={14}
                  r={12}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray={`${((remaining ?? 0) * 24 * Math.PI) / 100} ${24 * Math.PI}`}
                  opacity={remaining === null || remaining === 0 ? 0 : 1}
                  rotation={-90}
                  origin="14, 14"
                />
              </Svg>
              <Text allowFontScaling={false} className="text-foreground" style={{ fontSize: 9 }}>
                {remaining ?? "–"}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <Modal
        transparent
        visible={selection !== null}
        animationType="fade"
        onRequestClose={() => setSelection(null)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", paddingTop: insets.top + 44 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss usage details"
            onPress={() => setSelection(null)}
            style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.6)" }}
          />
          <View
            accessibilityViewIsModal
            className="rounded-t-2xl"
            style={{
              // A Modal renders outside the themed tree, so className colours resolve to
              // transparent here: give the sheet its theme colour explicitly.
              backgroundColor: theme["--color-sheet"],
              maxHeight: "80%",
              paddingBottom: Math.max(insets.bottom, 16),
            }}
          >
            <ScrollView>
              {selection ? (
                <>
                  <Text
                    className="px-4 pt-4 text-lg font-t3-bold"
                    style={{ color: theme["--color-foreground"] }}
                  >
                    {selection.driver === "codex" ? "OpenAI" : "Claude"} usage limits
                  </Text>
                  {!selectSidebarLimit(accounts, selection.driver, null) ? (
                    <Text className="p-4" style={{ color: theme["--color-foreground-muted"] }}>
                      No usage limit data yet:{" "}
                      {sidebarNoDataReason(presentations, selection.driver, null)}
                    </Text>
                  ) : null}
                  {accounts
                    .filter((account) => account.driver === selection.driver)
                    .map((account) => (
                      <AccountLimits
                        key={account.key}
                        driver={account.driver}
                        label={selection.driver === "codex" ? "OpenAI" : "Claude"}
                        instanceLabel={account.email ?? account.displayName ?? ""}
                        detail={account.plan}
                        footer={
                          <View className="gap-1">
                            {account.limits.windows.map((window) =>
                              window.resetsAt ? (
                                <Text
                                  key={window.id}
                                  className="text-xs"
                                  style={{ color: theme["--color-foreground-muted"] }}
                                >
                                  {window.label}: {formatLimitResetCountdown(window, selection.now)}{" "}
                                  ({new Date(window.resetsAt).toLocaleString()})
                                </Text>
                              ) : null,
                            )}
                          </View>
                        }
                        limits={account.limits}
                        now={selection.now}
                        first
                        dense
                      />
                    ))}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
