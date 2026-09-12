import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as NodeEvents from "node:events";

const state = vi.hoisted(() => ({ supported: true, show: vi.fn(), close: vi.fn() }));
const notifications: MockNotification[] = [];
class MockNotification extends NodeEvents.EventEmitter {
  static isSupported = () => state.supported;
  readonly options: { title: string; body: string; silent: boolean };
  constructor(options: { title: string; body: string; silent: boolean }) {
    super();
    this.options = options;
    notifications.push(this);
  }
  show = state.show;
  close = state.close;
}
vi.mock("electron", () => ({
  get Notification() {
    return MockNotification;
  },
}));
import { showCompletion } from "./ElectronNotification.ts";
import { COMPLETION_NOTIFICATION_CLICK_CHANNEL } from "../ipc/channels.ts";

const makeWindow = () => ({
  isDestroyed: () => false,
  isMinimized: () => true,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
});
const input = (turn: string) => ({
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make(turn),
  title: "Fix build",
});

describe("native completion notifications", () => {
  it.effect("shows a native alert and opens the exact environment/thread when clicked", () =>
    Effect.gen(function* () {
      const window = makeWindow();
      const target = input("click");
      assert.equal(yield* showCompletion(target, window), true);
      const notification = notifications.at(-1)!;
      assert.deepEqual(notification.options, {
        title: "Agent finished",
        body: "Fix build",
        silent: false,
      });
      notification.emit("click");
      assert.equal(window.restore.mock.calls.length, 1);
      assert.equal(window.focus.mock.calls.length, 1);
      assert.deepEqual(window.webContents.send.mock.calls, [
        [COMPLETION_NOTIFICATION_CLICK_CHANNEL, target],
      ]);
      assert.equal(yield* showCompletion(target, window), false);
      notification.emit("close");
    }),
  );

  it.effect("handles unsupported systems and permits retries after a native show failure", () =>
    Effect.gen(function* () {
      const window = makeWindow();
      state.supported = false;
      assert.equal(yield* showCompletion(input("retry"), window), false);
      state.supported = true;
      state.show.mockImplementationOnce(() => {
        throw new Error("native failure");
      });
      const error = yield* showCompletion(input("retry"), window).pipe(Effect.flip);
      assert.equal(error._tag, "NotificationError");
      assert.equal(yield* showCompletion(input("retry"), window), true);
    }),
  );
});
