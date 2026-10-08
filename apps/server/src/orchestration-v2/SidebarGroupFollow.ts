import {
  CommandId,
  followsSidebarParent,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

type FollowRequest = Extract<
  OrchestrationEffectRequestV2,
  { readonly type: "thread-group.follow" }
>;

const instant = (iso: string | null | undefined) =>
  iso == null ? null : Option.getOrNull(DateTime.make(iso));

/**
 * Apply a parent's settle or snooze (or the way back) to the threads nested
 * under it in the sidebar. Each child is re-checked against its current state
 * and gets its own command, so it takes its own thread lock and the usual
 * lifecycle rules: a child with active work refuses to settle and stays put.
 */
export const followSidebarParent = Effect.fn("orchestrationV2.sidebarGroup.follow")(
  function* (effect: {
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly request: FollowRequest;
  }) {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const { request } = effect;
    const parentSettledAt = instant(request.parentBefore.settledAt);
    const parentBefore = {
      settledOverride: parentSettledAt === null ? null : ("settled" as const),
      settledAt: parentSettledAt,
      snoozedUntil: instant(request.parentBefore.snoozedUntil),
      snoozedAt: instant(request.parentBefore.snoozedAt),
    };
    const now = yield* DateTime.now;
    for (const childThreadId of request.childThreadIds) {
      const child = yield* threads
        .getThreadShell(childThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (
        child === null ||
        child.archivedAt !== null ||
        child.sidebarParentThreadId !== effect.threadId ||
        !followsSidebarParent(child, parentBefore, request.action, now)
      ) {
        continue;
      }
      // Derived from the parent's command, so a replayed effect dedupes.
      const common = {
        commandId: CommandId.make(`${effect.commandId}:follow:${childThreadId}`),
        threadId: childThreadId,
      };
      const command: OrchestrationV2ServerCommand =
        request.action === "settle"
          ? {
              ...common,
              type: "thread.settle",
              ...(instant(request.settledAt) === null
                ? {}
                : { settledAt: instant(request.settledAt)! }),
            }
          : request.action === "unsettle"
            ? { ...common, type: "thread.unsettle", reason: "user" }
            : request.action === "snooze"
              ? {
                  ...common,
                  type: "thread.snooze",
                  snoozedUntil: request.snoozedUntil!,
                  ...(request.snoozedAt === undefined ? {} : { snoozedAt: request.snoozedAt }),
                }
              : { ...common, type: "thread.unsnooze", reason: "user" };
      yield* threads.dispatch(command).pipe(
        Effect.catch((cause) =>
          Effect.logInfo("Nested thread did not follow its parent", {
            childThreadId,
            action: request.action,
            cause,
          }),
        ),
      );
    }
  },
);
