import Constants from "expo-constants";
import { T } from "gt-react-native";
import { View } from "react-native";

import { PolyWordmark } from "./PolyWordmark";
import { resolveMobileStageLabel } from "../lib/mobileBranding";
import { AppText as Text } from "./ui/AppText";

const appVariant = Constants.expoConfig?.extra?.appVariant;
// PolyCode: production builds show no stage badge; Dev and Nightly keep theirs.
const DEFAULT_STAGE_LABEL = resolveMobileStageLabel(appVariant);

export function BrandMark(props: { readonly compact?: boolean; readonly stageLabel?: string }) {
  const compact = props.compact ?? false;
  const stageLabel = props.stageLabel ?? DEFAULT_STAGE_LABEL;

  return (
    <View className="flex-row items-center gap-3">
      <View className="gap-1">
        <View className="flex-row items-center gap-2">
          <PolyWordmark fontSize={compact ? 21 : 26} />
          {stageLabel ? (
            <View className="rounded-full bg-subtle px-2 py-1">
              <Text className="text-3xs font-t3-bold tracking-[1.1px] uppercase text-foreground-muted">
                {stageLabel}
              </Text>
            </View>
          ) : null}
        </View>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            <T>Mobile control surface for your live coding environments</T>
          </Text>
        ) : null}
      </View>
    </View>
  );
}
