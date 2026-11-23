import {
  behaviourLineSemantics,
  isBehaviourPath,
  type BehaviourLineSemantics,
} from "@t3tools/shared/behaviour";
import { useMemo } from "react";

/**
 * Polyzonia's behaviour language (`.beh`, `.pzb`) in the file viewer: the file tokenizes as plain
 * text (`BEHAVIOUR_HIGHLIGHT_LANGUAGE`), and these semantics colour it (`colorBehaviourLines`).
 */
export function useBehaviourSource(path: string, contents: string): BehaviourLineSemantics | null {
  return useMemo(
    () => (isBehaviourPath(path) ? behaviourLineSemantics(contents) : null),
    [path, contents],
  );
}
