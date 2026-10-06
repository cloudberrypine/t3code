import { describe, expect, it } from "vite-plus/test";

import { playWebBuildOptionsVersion, type PlayWebBuildButton } from "./playWebBuildButton";

const press = () => {};
const loading: PlayWebBuildButton = { loading: true, onPress: press };
const ready = (url: string): PlayWebBuildButton => ({ loading: false, url, onPress: press });

describe("playWebBuildOptionsVersion", () => {
  // The native header re-applies its items only when the options version
  // changes: the header factory's own source never does.
  it("changes when an open thread's button goes from loading to ready, or away", () => {
    const versions = [
      playWebBuildOptionsVersion(loading),
      playWebBuildOptionsVersion(ready("https://desk/play/__open?path=%2Fa")),
      playWebBuildOptionsVersion(ready("https://desk/play/__open?path=%2Fb")),
      playWebBuildOptionsVersion(undefined),
    ];
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("stays the same while the button does not change", () => {
    expect(playWebBuildOptionsVersion(ready("https://desk/play/a"))).toBe(
      playWebBuildOptionsVersion({ loading: false, url: "https://desk/play/a", onPress: () => {} }),
    );
    expect(playWebBuildOptionsVersion(loading)).toBe(
      playWebBuildOptionsVersion({ loading: true, onPress: () => {} }),
    );
  });
});
