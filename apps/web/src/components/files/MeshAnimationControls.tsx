import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Toggle } from "~/components/ui/toggle";
import type { useMeshAnimation } from "./useMeshAnimation";

export function MeshAnimationControls({
  animation,
}: {
  animation: ReturnType<typeof useMeshAnimation>;
}) {
  if (!animation.clips.length) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
      <Select
        value={animation.id}
        onValueChange={(value) => {
          if (value !== null) animation.select(value);
        }}
      >
        <SelectTrigger aria-label="Mesh animation" size="compact" className="w-auto max-w-full">
          <SelectValue>{animation.clip?.label ?? "Pose"}</SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value="">Pose</SelectItem>
          {animation.clips.map((clip) => (
            <SelectItem key={clip.id} value={clip.id}>
              {clip.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {animation.clip && (
        <>
          <Button size="sm" variant="ghost" onClick={animation.togglePlay}>
            {animation.playing ? "Pause" : "Play"}
          </Button>
          <Toggle size="sm" pressed={animation.loop} onPressedChange={animation.setLoop}>
            Loop
          </Toggle>
          <Select
            value={animation.speed}
            onValueChange={(value) => {
              if (value !== null) animation.setSpeed(value);
            }}
          >
            <SelectTrigger aria-label="Playback speed" size="compact" className="w-auto min-w-0">
              <SelectValue>{animation.speed}×</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {[0.25, 0.5, 1, 2].map((speed) => (
                <SelectItem key={speed} value={speed}>
                  {speed}×
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <input
            aria-label="Animation position"
            type="range"
            className="min-w-20 flex-1 accent-primary"
            min={0}
            max={animation.clip.duration}
            step={animation.clip.duration / 1000}
            value={animation.time}
            onChange={(event) => animation.seek(Number(event.target.value))}
          />
          <span className="text-2xs tabular-nums text-muted-foreground">
            {animation.time.toFixed(2)} / {animation.clip.duration.toFixed(2)}s
          </span>
        </>
      )}
    </div>
  );
}
