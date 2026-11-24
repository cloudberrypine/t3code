import { useAtomValue } from "@effect/atom-react";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import { remainingPercent } from "@t3tools/shared/usageLimits";
import { selectPooledSidebarRings, type SidebarRing } from "@t3tools/shared/sidebarUsageLimits";
import { formatLimitResetCountdown } from "@t3tools/shared/usageLimitFormatting";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentPresentations } from "../../state/presentation";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { AccountLimits } from "./UsageLimitsSection";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

// Two rings keep their 40 pt slots. More get 30 pt (the 28 pt ring, strokes 4 pt apart), so four
// take 120 pt and still fit beside the title on a 375 pt phone.
const ringSlotWidth = (count: number) => (count > 2 ? 30 : 40);
const ringRowWidth = (presentations: Parameters<typeof selectPooledSidebarRings>[0]) => {
  const count = selectPooledSidebarRings(presentations).length;
  return count * ringSlotWidth(count);
};

/** The ring row's width, for the header to leave the title the rest. Re-renders only when it
 * changes, not on every provider push. */
export function useHomeUsageRingsWidth() {
  return useAtomValue(environmentPresentations.presentationsWithProvidersAtom, ringRowWidth);
}

/** Reads the same live config snapshots as the desktop sidebar, including hub accounts. It has
 * no primary environment, so its rings pool every connected environment's instances. */
export function HomeUsageRings() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const rings = selectPooledSidebarRings(presentations);
  const [selection, setSelection] = useState<{ key: string; now: number } | null>(null);
  const { themeAppearance } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  // With one ring per driver the phone keeps its driver names; several are told apart by instance.
  const ringLabel = (ring: SidebarRing) =>
    rings.filter((other) => other.driver === ring.driver).length > 1
      ? ring.title
      : ring.driver === "codex"
        ? "OpenAI"
        : "Claude";
  const selected = rings.find((ring) => ring.key === selection?.key);
  // The sheet follows its ring's account. Once that ring is gone the sheet closes for good, so a
  // ring that later takes the same key never reopens it without a tap.
  if (selection && !selected) setSelection(null);
  return (
    <View style={{ flexDirection: "row" }}>
      {rings.map((ring) => {
        const { driver, window } = ring;
        const remaining = window ? remainingPercent(window) : null;
        const label = ringLabel(ring);
        const color =
          normalizeProviderAccentColor(ring.accentColor) ??
          (driver === "codex"
            ? themeAppearance === "dark"
              ? "#e6e6e6"
              : "#3c3c43"
            : themeAppearance === "dark"
              ? "#d97757"
              : "#b85e40");
        return (
          <Pressable
            key={ring.key}
            accessibilityRole="button"
            accessibilityLabel={`${label} usage, ${remaining === null ? "unavailable" : `${remaining}% left`}`}
            accessibilityHint="Shows usage limits and reset times"
            onPress={() => setSelection({ key: ring.key, now: Date.now() })}
            style={{
              width: ringSlotWidth(rings.length),
              height: 44,
              alignItems: "center",
              justifyContent: "center",
            }}
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
        visible={selected !== undefined}
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
              {selection && selected ? (
                <>
                  <Text
                    className="px-4 pt-4 text-lg font-t3-bold"
                    style={{ color: theme["--color-foreground"] }}
                  >
                    {ringLabel(selected)} usage limits
                  </Text>
                  {!selected.window ? (
                    <Text className="p-4" style={{ color: theme["--color-foreground-muted"] }}>
                      No usage limit data yet: {selected.noDataReason}
                    </Text>
                  ) : null}
                  {selected.account ? (
                    <AccountLimits
                      key={selected.account.key}
                      driver={selected.account.driver}
                      accentColor={selected.accentColor}
                      label={selected.driver === "codex" ? "OpenAI" : "Claude"}
                      instanceLabel={selected.account.email ?? selected.account.displayName ?? ""}
                      detail={selected.account.plan}
                      footer={
                        <View className="gap-1">
                          {selected.account.limits.windows.map((window) =>
                            window.resetsAt ? (
                              <Text
                                key={window.id}
                                className="text-xs"
                                style={{ color: theme["--color-foreground-muted"] }}
                              >
                                {window.label}: {formatLimitResetCountdown(window, selection.now)} (
                                {new Date(window.resetsAt).toLocaleString()})
                              </Text>
                            ) : null,
                          )}
                        </View>
                      }
                      limits={selected.account.limits}
                      now={selection.now}
                      first
                      dense
                    />
                  ) : null}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
