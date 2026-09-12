import { DEFAULT_CLIENT_SETTINGS, DesktopCompletionNotification } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronNotification from "../../electron/ElectronNotification.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { COMPLETION_NOTIFICATION_CHANNEL } from "../channels.ts";

export const showCompletionNotification = DesktopIpc.makeIpcMethod({
  channel: COMPLETION_NOTIFICATION_CHANNEL,
  payload: DesktopCompletionNotification,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.showCompletion")(function* (input) {
    const settings = yield* DesktopClientSettings.DesktopClientSettings;
    const current = Option.getOrElse(yield* settings.get, () => DEFAULT_CLIENT_SETTINGS);
    if (!current.desktopCompletionNotificationsEnabled) return false;
    const windows = yield* ElectronWindow.ElectronWindow;
    const window = yield* windows.currentMainOrFirst;
    if (Option.isNone(window)) return false;
    return yield* ElectronNotification.showCompletion(input, window.value);
  }),
});
