import {
  behaviourColors,
  behaviourLineSemantics,
  isBehaviourPath,
  type BehaviourLineSemantics,
} from "@t3tools/shared/behaviour";
import { useMemo } from "react";

import type { HighlightScheme } from "../../lib/highlights";

/**
 * Polyzonia's behaviour language (`.beh`, `.pzb`) in the file viewer: the file tokenizes as plain
 * text (`BEHAVIOUR_HIGHLIGHT_LANGUAGE`), and these semantics colour it (`colorBehaviourLines`) and
 * mark its waiting lines.
 */
export function useBehaviourSource(path: string, contents: string): BehaviourLineSemantics | null {
  return useMemo(
    () => (isBehaviourPath(path) ? behaviourLineSemantics(contents) : null),
    [path, contents],
  );
}

/** A 1-based line's full-strength wait background, if it waits. */
export function behaviourWaitBackground(
  semantics: BehaviourLineSemantics | null,
  line: number,
  scheme: HighlightScheme,
): string | undefined {
  return semantics?.lines.get(line) === "wait" ? behaviourColors[scheme].waitBackground : undefined;
}
