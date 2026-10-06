import type { ThemeRegistration } from "@shikijs/core";
import pierreDark from "@pierre/theme/pierre-dark";
import pierreLight from "@pierre/theme/pierre-light";

/**
 * Desktop colors every code surface with Pierre's syntax themes (`resolveDiffThemeName` in
 * apps/web/src/lib/diffRendering.ts), whatever the app theme. Mobile tokenizes with the same
 * themes so source files and diffs read alike on both.
 */
export const DESKTOP_CODE_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

// Shiki copies a theme before normalizing it, so the frozen package objects are safe to pass.
export const DESKTOP_CODE_THEMES = [pierreLight, pierreDark] as unknown as ThemeRegistration[];
