import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import type { useMeshAnimation } from "./useMeshAnimation";

export function MeshAnimationControls({
  animation,
}: {
  animation: ReturnType<typeof useMeshAnimation>;
}) {
  const [width, setWidth] = useState(1);
  if (!animation.clips.length) return null;
  const duration = animation.clip?.duration ?? 1;
  const seekAt = (x: number) => animation.seek((x / width) * duration);
  return (
    <View className="border-b border-border px-3 py-1">
      <View className="flex-row flex-wrap items-center gap-2">
        <ControlPillMenu
          title="Mesh animation"
          accessibilityLabel="Mesh animation"
          actions={[
            { id: "pose", title: "Pose", state: animation.clip ? "off" : "on" },
            ...animation.clips.map((clip) => ({
              id: clip.id,
              title: clip.label,
              state: animation.id === clip.id ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={(event) =>
            animation.select(event.nativeEvent.event === "pose" ? "" : event.nativeEvent.event)
          }
        >
          <View className="min-h-11 justify-center">
            <Text className="text-xs text-foreground">{animation.clip?.label ?? "Pose"} ▾</Text>
          </View>
        </ControlPillMenu>
        {animation.clip && (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={animation.togglePlay}
              className="min-h-11 justify-center px-2"
            >
              <Text className="text-xs text-foreground">
                {animation.playing ? "Pause" : "Play"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: animation.loop }}
              onPress={() => animation.setLoop(!animation.loop)}
              className={`min-h-11 justify-center rounded-lg px-2 ${animation.loop ? "bg-surface" : ""}`}
            >
              <Text className="text-xs text-foreground">Loop</Text>
            </Pressable>
            <ControlPillMenu
              title="Playback speed"
              accessibilityLabel="Playback speed"
              actions={[0.25, 0.5, 1, 2].map((speed) => ({
                id: String(speed),
                title: `${speed}×`,
                state: animation.speed === speed ? "on" : "off",
              }))}
              onPressAction={(event) => animation.setSpeed(Number(event.nativeEvent.event))}
            >
              <View className="min-h-11 justify-center px-2">
                <Text className="text-xs text-foreground">{animation.speed}× ▾</Text>
              </View>
            </ControlPillMenu>
          </>
        )}
      </View>
      {animation.clip && (
        <View className="flex-row items-center gap-2">
          <View
            className="h-11 flex-1 justify-center"
            onLayout={(event) => setWidth(Math.max(1, event.nativeEvent.layout.width))}
            accessibilityRole="adjustable"
            accessibilityLabel="Animation position"
            accessibilityValue={{ min: 0, max: duration, now: animation.time }}
            accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
            onAccessibilityAction={(event) =>
              animation.seek(
                animation.time +
                  ((event.nativeEvent.actionName === "increment" ? 1 : -1) * duration) / 100,
              )
            }
            onStartShouldSetResponder={() => true}
            onResponderGrant={(event) => seekAt(event.nativeEvent.locationX)}
            onResponderMove={(event) => seekAt(event.nativeEvent.locationX)}
          >
            <View pointerEvents="none" className="h-1 rounded-full bg-surface">
              <View
                className="h-1 rounded-full bg-foreground"
                style={{ width: `${(animation.time / duration) * 100}%` }}
              />
            </View>
            <View
              pointerEvents="none"
              className="absolute size-4 rounded-full bg-foreground"
              style={{ left: Math.max(0, ((width - 16) * animation.time) / duration) }}
            />
          </View>
          <Text className="text-xs text-foreground-muted">
            {animation.time.toFixed(2)} / {duration.toFixed(2)}s
          </Text>
        </View>
      )}
    </View>
  );
}
