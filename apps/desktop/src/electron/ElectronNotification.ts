import type { DesktopCompletionNotification } from "@t3tools/contracts";
import { Notification, type BrowserWindow, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { COMPLETION_NOTIFICATION_CLICK_CHANNEL } from "../ipc/channels.ts";

export class NotificationError extends Schema.TaggedErrorClass<NotificationError>()(
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

export const showCompletion = Effect.fn("electron.notifications.showCompletion")(function* (
  input: DesktopCompletionNotification,
  window: NotificationWindow,
) {
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  return yield* Effect.try({
    try: () => {
      const key = encodeKey([input.environmentId, input.threadId, input.turnId]);
      if (!Notification.isSupported() || delivered.has(key)) return false;
      const notification = new Notification({
        title: "Agent finished",
        body: input.title.slice(0, 240),
        silent: false,
      });
      notification.once("click", () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send(COMPLETION_NOTIFICATION_CLICK_CHANNEL, input);
      });
      notification.once("close", () => active.delete(notification));
      notification.once("failed", (_event, error) => {
        active.delete(notification);
        delivered.delete(key);
        runFork(Effect.logError("Could not show agent completion notification", error));
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
});
