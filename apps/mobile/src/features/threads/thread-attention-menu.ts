import type { MenuAction } from "@react-native-menu/menu";
import type { ScreenHeaderMenuItem } from "../../components/ScreenHeader.types";

type ThreadAttention = { readonly reason: string } | null | undefined;

export function buildThreadAttentionMenuItems(attention: ThreadAttention): MenuAction[] {
  if (!attention) return [];
  return [
    {
      id: "thread-flag-reason",
      title: attention.reason,
      displayInline: true,
      subactions: [{ id: "clear-thread-flag", title: "Clear flag", image: "flag.slash" }],
    },
  ];
}

export function handleThreadAttentionMenuAction(event: string, onClear: () => void): boolean {
  if (event === "thread-flag-reason") return true;
  if (event !== "clear-thread-flag") return false;
  onClear();
  return true;
}

export function buildThreadAttentionHeaderItems(
  attention: ThreadAttention,
  onClear: () => void,
): ScreenHeaderMenuItem[] {
  if (!attention) return [];
  return [
    {
      id: "thread-flag-reason",
      title: attention.reason,
      inline: true,
      items: [
        { id: "clear-thread-flag", title: "Clear flag", icon: "flag.slash", onPress: onClear },
      ],
    },
  ];
}
