import { useEffect, useMemo, useState } from "react";

import {
  advanceMeshPlayback,
  meshAnimationClips,
  sampleMeshAnimation,
} from "@t3tools/client-runtime/polyzonia-animation";
import type { PolyzoniaMesh } from "@t3tools/client-runtime/polyzonia-mesh";

const initial = (mesh: PolyzoniaMesh) => ({
  mesh,
  id: "",
  time: 0,
  playing: false,
  loop: true,
  speed: 1,
});
export function useMeshAnimation(mesh: PolyzoniaMesh) {
  const [stored, setStored] = useState(() => initial(mesh));
  const state = stored.mesh === mesh ? stored : initial(mesh);
  const clips = useMemo(() => meshAnimationClips(mesh), [mesh]);
  const clip = clips.find((item) => item.id === state.id) ?? null;
  const { playing, loop, speed } = state;
  const sample = useMemo(
    () => (clip ? sampleMeshAnimation(mesh, clip, state.time, loop) : null),
    [mesh, clip, state.time, loop],
  );
  useEffect(() => {
    if (!playing || !clip) return;
    let frame: number | null = null;
    let last: number | null = null;
    const tick = (now: number) => {
      // Sample every display frame, just like scrubbing, using elapsed time for speed.
      if (last !== null) {
        const elapsed = ((now - last) / 1000) * speed;
        setStored((current) =>
          current.mesh !== mesh
            ? current
            : {
                ...current,
                ...advanceMeshPlayback(current.time, elapsed, clip.duration, loop),
              },
        );
      }
      last = now;
      frame = requestAnimationFrame(tick);
    };
    const syncVisibility = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      last = null;
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    document.addEventListener("visibilitychange", syncVisibility);
    syncVisibility();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", syncVisibility);
    };
  }, [mesh, playing, clip, loop, speed]);
  const update = (change: Partial<Omit<ReturnType<typeof initial>, "mesh">>) =>
    setStored((current) => ({ ...(current.mesh === mesh ? current : initial(mesh)), ...change }));
  return {
    ...state,
    clips,
    clip,
    sample,
    select: (id: string) => update({ id, time: 0, playing: false }),
    seek: (time: number) =>
      update({ time: Math.max(0, Math.min(clip?.duration ?? 0, time)), playing: false }),
    togglePlay: () => {
      if (clip) update({ playing: !playing, time: state.time >= clip.duration ? 0 : state.time });
    },
    setLoop: (loop: boolean) => update({ loop }),
    setSpeed: (speed: number) => update({ speed }),
  };
}
