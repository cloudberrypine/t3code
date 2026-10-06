import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
import { isCppPath } from "@t3tools/shared/cppNavigation";

/**
 * The grammar desktop picks for a path (Pierre's mapping, so `.h` is objective-cpp, a C++
 * superset). C/C++ extensions Pierre does not know (`.hxx`, `.inl`, `.ipp`, ...) read as C++,
 * as go-to-definition already treats them, instead of plain text.
 */
export function desktopCodeLanguage(path: string): string {
  const language = getFiletypeFromFileName(path);
  return (!language || language === "text") && isCppPath(path) ? "cpp" : language;
}
