// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not invent configuration when no env files exist", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.T3CODE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.T3CODE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.T3CODE_RELAY_URL).toBeUndefined();
    expect(env.VITE_T3CODE_RELAY_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("uses only the four public Connect defaults from the example file", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.example"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_example\nT3CODE_CLERK_JWT_TEMPLATE=example_jwt\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=example_oauth\nT3CODE_RELAY_URL=https://example.test\nT3CODE_MOBILE_OTLP_TRACES_TOKEN=ignored\nVITE_HTTP_URL=http://ignored.test\n",
    );
    const env = loadRepoEnv({ baseEnv: {}, repoRoot });
    expect(env).toEqual({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_example",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_example",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_example",
      T3CODE_CLERK_JWT_TEMPLATE: "example_jwt",
      VITE_CLERK_JWT_TEMPLATE: "example_jwt",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "example_jwt",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "example_oauth",
      VITE_CLERK_CLI_OAUTH_CLIENT_ID: "example_oauth",
      T3CODE_RELAY_URL: "https://example.test",
      VITE_T3CODE_RELAY_URL: "https://example.test",
    });

    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "VITE_T3CODE_RELAY_URL=https://root.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe("https://root.test");
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_RELAY_URL=https://local.test\n",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe("https://local.test");
    expect(
      loadRepoEnv({ baseEnv: { VITE_T3CODE_RELAY_URL: " https://process.test " }, repoRoot })
        .T3CODE_RELAY_URL,
    ).toBe("https://process.test");
    expect(
      loadRepoEnv({ baseEnv: { T3CODE_CLERK_PUBLISHABLE_KEY: "  " }, repoRoot })
        .T3CODE_CLERK_PUBLISHABLE_KEY,
    ).toBe("pk_example");
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
