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
