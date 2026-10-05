import type { DesktopAgentNotification } from "@t3tools/contracts";
import { Notification, type BrowserWindow, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AGENT_NOTIFICATION_CLICK_CHANNEL } from "../ipc/channels.ts";

export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "NotificationError",
  { cause: Schema.Defect() },
) {}

// Retain native notifications until closed; bound duplicate tracking across renderer remounts.
const active = new Set<Notification>();
const delivered = new Set<string>();

const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
type NotificationWindow = Pick<
  BrowserWindow,
  "isDestroyed" | "isMinimized" | "restore" | "show" | "focus"
> & {
  webContents: Pick<WebContents, "send">;
};

export const showAgentNotification = Effect.fn("electron.notifications.showAgentNotification")(
  function* (input: DesktopAgentNotification, window: NotificationWindow) {
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    return yield* Effect.try({
      try: () => {
        const key = encodeKey([
          input.environmentId,
          input.threadId,
          input.kind,
          input.kind === "question" ? input.requestId : input.turnId,
        ]);
        if (!Notification.isSupported() || delivered.has(key)) return false;
        const notification = new Notification({
          title: input.kind === "question" ? "Agent has a question" : "Agent finished",
          body: input.title.slice(0, 240),
          silent: false,
        });
        notification.once("click", () => {
          if (window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
          window.webContents.send(AGENT_NOTIFICATION_CLICK_CHANNEL, input);
        });
        notification.once("close", () => active.delete(notification));
        notification.once("failed", (_event, error) => {
          active.delete(notification);
          delivered.delete(key);
          runFork(Effect.logError("Could not show agent notification", error));
        });
        active.add(notification);
        delivered.add(key);
        if (delivered.size > 512) delivered.delete(delivered.values().next().value!);
        if (active.size > 64) {
          const oldest = active.values().next().value!;
          active.delete(oldest);
          oldest.close();
        }
        try {
          notification.show();
        } catch (error) {
          active.delete(notification);
          delivered.delete(key);
          throw error;
        }
        return true;
      },
      catch: (cause) => new NotificationError({ cause }),
    });
  },
);
