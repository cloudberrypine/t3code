import * as DateTime from "effect/DateTime";

/**
 * Threads nested under another thread in the sidebar (`sidebarParentThreadId`)
 * follow the parent when it is settled or snoozed, and come back with it.
 * A child takes the parent's settle or snooze stamp, which is how the way
 * back finds it: a child parked on its own carries its own stamp and stays.
 */
export type SidebarGroupAction = "settle" | "unsettle" | "snooze" | "unsnooze";

export interface SidebarParkState {
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: DateTime.Utc | null;
  readonly snoozedUntil?: DateTime.Utc | null | undefined;
  readonly snoozedAt?: DateTime.Utc | null | undefined;
}

const sameInstant = (
  left: DateTime.Utc | null | undefined,
  right: DateTime.Utc | null | undefined,
) =>
  left != null && right != null && DateTime.toEpochMillis(left) === DateTime.toEpochMillis(right);

const isSettled = (thread: SidebarParkState) => thread.settledOverride === "settled";

const isSnoozed = (thread: SidebarParkState, now: DateTime.Utc) =>
  thread.snoozedUntil != null &&
  DateTime.toEpochMillis(thread.snoozedUntil) > DateTime.toEpochMillis(now);

const settledWith = (child: SidebarParkState, parent: SidebarParkState) =>
  isSettled(child) && isSettled(parent) && sameInstant(child.settledAt, parent.settledAt);

const snoozedWith = (child: SidebarParkState, parent: SidebarParkState) =>
  sameInstant(child.snoozedUntil, parent.snoozedUntil) &&
  sameInstant(child.snoozedAt, parent.snoozedAt);

/**
 * Whether a nested thread follows its parent's lifecycle action. `parent` is
 * the parent's state before the action. Parking takes children that are live
 * or parked together with the parent; the way back takes only the latter.
 */
export function followsSidebarParent(
  child: SidebarParkState,
  parent: SidebarParkState,
  action: SidebarGroupAction,
  now: DateTime.Utc,
): boolean {
  const parkedAlone =
    (isSettled(child) && !settledWith(child, parent)) ||
    (isSnoozed(child, now) && !snoozedWith(child, parent));
  switch (action) {
    case "settle":
      return !parkedAlone && !isSettled(child);
    case "snooze":
      return !parkedAlone;
    case "unsettle":
      return settledWith(child, parent);
    case "unsnooze":
      return isSnoozed(child, now) && snoozedWith(child, parent);
  }
}
