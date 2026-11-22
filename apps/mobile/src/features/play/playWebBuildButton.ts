import type { AppBarAction } from "../../components/ui/AppBar.types";

/** The thread header's "Play web build": disabled while its availability is being checked. */
export type PlayWebBuildButton =
  | { readonly loading: true; readonly onPress: () => void }
  | { readonly loading: false; readonly url: string; readonly onPress: () => void };

/**
 * The button's part of the thread header's `optionsVersion`. The native header
 * re-applies its items only when that version changes (its factory is
 * stabilized), so an open thread needs it to follow loading → ready.
 */
export function playWebBuildOptionsVersion(button: PlayWebBuildButton | undefined): string {
  if (button === undefined) return "play:none";
  return button.loading ? "play:loading" : `play:ready:${button.url}`;
}

/** The thread bar's ▶ action, or null when the thread cannot play a web build. */
export function playWebBuildHeaderAction(
  button: PlayWebBuildButton | undefined,
  gt: (text: string) => string,
): AppBarAction | null {
  if (button === undefined) return null;
  return {
    accessibilityLabel: button.loading ? gt("Play web build (checking)") : gt("Play web build"),
    icon: "play",
    disabled: button.loading,
    separateBackground: false,
    onPress: button.onPress,
  };
}
