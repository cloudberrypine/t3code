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
import { showAgentNotification } from "./ElectronNotification.ts";
import { AGENT_NOTIFICATION_CLICK_CHANNEL } from "../ipc/channels.ts";

const makeWindow = () => ({
  isDestroyed: () => false,
  isMinimized: () => true,
  restore: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { send: vi.fn() },
});
const input = (turn: string) => ({
  kind: "completed" as const,
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
  turnId: TurnId.make(turn),
  title: "Fix build",
});

describe("native agent notifications", () => {
  it.effect("delivers questions independently of completions and opens their thread", () =>
    Effect.gen(function* () {
      const window = makeWindow();
      const { turnId: _turnId, ...target } = input("question-turn");
      const question = { ...target, kind: "question" as const, requestId: "question-1" };
      assert.equal(yield* showAgentNotification(question, window), true);
      const notification = notifications.at(-1)!;
      assert.equal(notification.options.title, "Agent has a question");
      assert.equal(notification.options.body, "Fix build");
      notification.emit("click");
      assert.deepEqual(window.webContents.send.mock.calls, [
        [AGENT_NOTIFICATION_CLICK_CHANNEL, question],
      ]);
      assert.equal(yield* showAgentNotification(question, window), false);
      assert.equal(
        yield* showAgentNotification({ ...question, requestId: "question-2" }, window),
        true,
      );
      assert.equal(yield* showAgentNotification(input("question-turn"), window), true);
    }),
  );

  it.effect("shows a native alert and opens the exact environment/thread when clicked", () =>
    Effect.gen(function* () {
      const window = makeWindow();
      const target = input("click");
      assert.equal(yield* showAgentNotification(target, window), true);
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
        [AGENT_NOTIFICATION_CLICK_CHANNEL, target],
      ]);
      assert.equal(yield* showAgentNotification(target, window), false);
      notification.emit("close");
    }),
  );

  it.effect("handles unsupported systems and permits retries after a native show failure", () =>
    Effect.gen(function* () {
      const window = makeWindow();
      state.supported = false;
      assert.equal(yield* showAgentNotification(input("retry"), window), false);
      state.supported = true;
      state.show.mockImplementationOnce(() => {
        throw new Error("native failure");
      });
      const error = yield* showAgentNotification(input("retry"), window).pipe(Effect.flip);
      assert.equal(error._tag, "NotificationError");
      assert.equal(yield* showAgentNotification(input("retry"), window), true);
    }),
  );
});
