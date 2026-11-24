import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ selection: null as unknown, presentations: new Map() }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    state.selection,
    (value: unknown) => {
      state.selection = value;
    },
  ],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("react-native", () => ({
  Modal: "modal",
  Pressable: "button",
  ScrollView: "scroll",
  View: "view",
}));
vi.mock("react-native-svg", () => ({ default: "svg", Circle: "circle" }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 50, bottom: 34 }),
}));
vi.mock("../../components/ui/AppText", () => ({ AppText: "text" }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsWithProvidersAtom: null },
}));
vi.mock("./UsageLimitsSection", () => ({ AccountLimits: "account" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "dark",
    themeVariables: {
      "--color-sheet": "#202020",
      "--color-foreground": "#eeeeee",
      "--color-foreground-muted": "#aaaaaa",
    },
  }),
}));
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { HomeUsageRings } from "./HomeUsageRings";

type Props = {
  children?: unknown;
  accessibilityLabel?: string;
  onPress?: () => void;
  visible?: boolean;
  opacity?: number;
  limits?: unknown;
  instanceLabel?: string;
  accentColor?: string;
  style?: { width?: number };
};
function nodes(value: unknown): ReactElement<Props>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Props>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
const instance = (
  instanceId: string,
  driver: "codex" | "claudeAgent",
  email: string | undefined,
  windows: { id: string; kind: "session" | "weekly"; usedPercent: number }[],
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: email ? { status: "authenticated", email } : { status: "unauthenticated" },
  checkedAt: "2026-11-24T10:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: email
    ? {
        checkedAt: "2026-11-24T10:00:00Z",
        windows: windows.map((window) => ({ ...window, label: window.id })),
      }
    : undefined,
  ...overrides,
});
const environment = (...providers: ServerProvider[]) =>
  new Map([
    [
      EnvironmentId.make("mac"),
      {
        entry: { target: { label: "Mac" } },
        connection: { phase: "connected" },
        serverConfig: { providers },
      },
    ],
  ]);
const environments = (...entries: [label: string, providers: ServerProvider[]][]) =>
  new Map(
    entries.map(([label, providers]) => [
      EnvironmentId.make(label),
      {
        entry: { target: { label } },
        connection: { phase: "connected" },
        serverConfig: { providers },
      },
    ]),
  );
const sheet = () => {
  const tree = nodes(HomeUsageRings());
  return {
    visible: tree.find((node) => node.type === "modal")?.props.visible,
    accounts: tree
      .filter((node) => node.type === "account")
      .map((node) => node.props.instanceLabel),
  };
};
const weekly = (usedPercent: number) => [{ id: "seven_day", kind: "weekly" as const, usedPercent }];
beforeEach(() => {
  state.selection = null;
  state.presentations = new Map();
});
it("opens provider details on tap and dismisses them from the backdrop", () => {
  let tree = nodes(HomeUsageRings());
  const buttons = tree.filter((node) => node.type === "button");
  expect(buttons.slice(0, 2).map((node) => node.props.accessibilityLabel)).toEqual([
    "OpenAI usage, unavailable",
    "Claude usage, unavailable",
  ]);
  expect(tree.find((node) => node.type === "modal")?.props.visible).toBe(false);
  buttons[1]!.props.onPress!();
  tree = nodes(HomeUsageRings());
  expect(tree.find((node) => node.type === "modal")?.props.visible).toBe(true);
  expect(state.selection).toMatchObject({ key: "claudeAgent" });
  tree.find((node) => node.props.accessibilityLabel === "Dismiss usage details")!.props.onPress!();
  expect(nodes(HomeUsageRings()).find((node) => node.type === "modal")?.props.visible).toBe(false);
});
it("uses the shared weekly selection and leaves a provider without data empty", () => {
  state.presentations = environment(
    instance("codex", "codex", "me@example.com", [
      { id: "five_hour", kind: "session", usedPercent: 5 },
      { id: "seven_day", kind: "weekly", usedPercent: 72 },
    ]),
    instance("claudeAgent", "claudeAgent", undefined, []),
  );
  const tree = nodes(HomeUsageRings());
  expect(
    tree.find((node) => node.props.accessibilityLabel === "OpenAI usage, 28% left"),
  ).toBeDefined();
  expect(
    tree.find((node) => node.props.accessibilityLabel === "Claude usage, unavailable"),
  ).toBeDefined();
  expect(tree.filter((node) => node.type === "circle" && node.props.opacity === 0)).toHaveLength(1);
});
it("draws a narrower ring per Claude account and opens only the tapped ring's account", () => {
  state.presentations = environment(
    instance("codex", "codex", "me@example.com", weekly(27)),
    instance("claudeAgent", "claudeAgent", "one@example.com", weekly(27)),
    instance("claude2", "claudeAgent", "two@example.com", weekly(90), {
      displayName: "Claude 2",
      accentColor: "#22aa44",
    }),
  );
  let tree = nodes(HomeUsageRings());
  const buttons = tree.filter((node) => node.type === "button");
  expect(buttons.slice(0, 3).map((node) => node.props.accessibilityLabel)).toEqual([
    "OpenAI usage, 73% left",
    "Claude (one@example.com) usage, 73% left",
    "Claude 2 (two@example.com) usage, 10% left",
  ]);
  expect(buttons.slice(0, 3).map((node) => node.props.style?.width)).toEqual([30, 30, 30]);
  buttons[2]!.props.onPress!();
  tree = nodes(HomeUsageRings());
  expect(tree.find((node) => node.type === "modal")?.props.visible).toBe(true);
  expect(
    tree
      .filter((node) => node.type === "account")
      .map((node) => [node.props.instanceLabel, node.props.accentColor]),
  ).toEqual([["two@example.com", "#22aa44"]]);
});
it("keeps the sheet on the tapped ring's account and closes it for good when that ring goes", () => {
  const alice = instance("codex", "codex", "alice@example.com", weekly(20));
  const bob = instance("codex", "codex", "bob@example.com", weekly(90));
  state.presentations = environments(["Mac", [alice]], ["Linux", [bob]]);
  nodes(HomeUsageRings()).find((node) =>
    node.props.accessibilityLabel?.startsWith("Codex (alice@example.com)"),
  )!.props.onPress!();
  expect(sheet()).toEqual({ visible: true, accounts: ["alice@example.com"] });
  // Linux reports Alice too; the Mac leaving hands her ring to Linux, and the sheet stays.
  const aliceOnLinux = instance("codex2", "codex", "ALICE@example.com", weekly(30));
  state.presentations = environments(["Mac", [alice]], ["Linux", [bob, aliceOnLinux]]);
  expect(sheet()).toEqual({ visible: true, accounts: ["alice@example.com"] });
  state.presentations = environments(["Linux", [bob, aliceOnLinux]]);
  expect(sheet()).toEqual({ visible: true, accounts: ["ALICE@example.com"] });
  // Alice's ring goes: the sheet closes, and neither Carol on her instance nor Alice's return
  // reopens it.
  state.presentations = environments(["Linux", [bob]]);
  expect(sheet().visible).toBe(false);
  state.presentations = environments(
    ["Linux", [bob]],
    ["Mac", [instance("codex", "codex", "carol@example.com", weekly(50))]],
  );
  expect(sheet()).toEqual({ visible: false, accounts: [] });
  state.presentations = environments(["Linux", [bob, aliceOnLinux]]);
  expect(sheet()).toEqual({ visible: false, accounts: [] });
});
