import { isValidElement, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ selection: null as unknown, accounts: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: () => [
    state.selection,
    (value: unknown) => {
      state.selection = value;
    },
  ],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("@t3tools/shared/usageLimits", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/usageLimits")>()),
  collectLimitAccounts: () => state.accounts,
}));
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
vi.mock("../../components/AppText", () => ({ AppText: "text" }));
vi.mock("../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: null },
}));
vi.mock("./UsageLimitsSection", () => ({ AccountLimits: "account" }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));
import { HomeUsageRings } from "./HomeUsageRings";

type Props = {
  children?: unknown;
  accessibilityLabel?: string;
  onPress?: () => void;
  visible?: boolean;
  opacity?: number;
  limits?: unknown;
};
function nodes(value: unknown): ReactElement<Props>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Props>(value)) return [];
  return [value, ...nodes(value.props.children)];
}
beforeEach(() => {
  state.selection = null;
  state.accounts = [];
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
  expect(state.selection).toMatchObject({ driver: "claudeAgent" });
  tree.find((node) => node.props.accessibilityLabel === "Dismiss usage details")!.props.onPress!();
  expect(nodes(HomeUsageRings()).find((node) => node.type === "modal")?.props.visible).toBe(false);
});
it("uses the shared weekly selection and leaves missing providers empty", () => {
  state.accounts = [
    {
      key: "openai",
      driver: "codex",
      environments: [],
      limits: {
        windows: [
          { kind: "session", usedPercent: 5 },
          { kind: "weekly", usedPercent: 72 },
        ],
      },
    },
  ];
  const tree = nodes(HomeUsageRings());
  expect(
    tree.find((node) => node.props.accessibilityLabel === "OpenAI usage, 28% left"),
  ).toBeDefined();
  expect(
    tree.find((node) => node.props.accessibilityLabel === "Claude usage, unavailable"),
  ).toBeDefined();
  expect(tree.filter((node) => node.type === "circle" && node.props.opacity === 0)).toHaveLength(1);
});
