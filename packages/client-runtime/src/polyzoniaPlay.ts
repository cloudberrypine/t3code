/**
 * Polyzonia play links (fork-only; the server side is apps/server/src/play).
 *
 * An environment's `/play/*` route proxies Polyzonia's per-worktree web builds,
 * and threads post links to them: `https://<host>/play/<worktree>/#ticket=<t>`.
 * The ticket signs one browser in; the page redeems it for a cookie scoped to
 * `/play`. Clients open a play link in their own web view, instead of the
 * system browser, when its host is one of the thread's environment's own
 * addresses: its T3 Connect host or a direct (LAN, tailnet) one.
 */
import { AuthOrchestrationOperateScope, type AuthSessionState } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./connection/catalog.ts";
import { connectionRoutes } from "./connection/routes.ts";

/** Mints a ticket for an operate session (or the play key). */
export const PLAY_TICKET_PATH = "/play/__auth/ticket";
/** The play server's own state, with the repository it serves (`repo`). */
export const PLAY_HEALTH_PATH = "/play/__health";

/** The page a play link opens, or null when `href` is not one. */
export function parsePlayLink(href: string): URL | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  // `/play/__auth/*` is the proxy's sign-in API, never a page.
  if (!url.pathname.startsWith("/play/") || url.pathname.startsWith("/play/__auth/")) return null;
  return url;
}

/** `scheme://host[:port]` of each URL that parses, without duplicates. */
function originsOf(urls: Iterable<string | null | undefined>): ReadonlyArray<string> {
  const origins = new Set<string>();
  for (const value of urls) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") origins.add(url.origin);
    } catch {
      // Not a URL: nothing to match.
    }
  }
  return [...origins];
}

/**
 * The addresses play links of one environment may use: every direct route the
 * client saved for it, plus `httpBaseUrls` the client knows at runtime (the
 * prepared connection's, T3 Connect's endpoint for the environment).
 */
export function environmentPlayOrigins(input: {
  readonly entry: ConnectionCatalogEntry | undefined;
  readonly httpBaseUrls: ReadonlyArray<string | null | undefined>;
}): ReadonlyArray<string> {
  const saved: Array<string> = [];
  if (input.entry) {
    for (const route of connectionRoutes(input.entry)) {
      if (route.target._tag === "PrimaryConnectionTarget") saved.push(route.target.httpBaseUrl);
      const profile = Option.getOrUndefined(route.profile);
      if (profile?._tag === "BearerConnectionProfile") saved.push(profile.httpBaseUrl);
    }
  }
  return originsOf([...saved, ...input.httpBaseUrls]);
}

export interface PlayLinkRequest<EnvironmentId extends string = string> {
  readonly environmentId: EnvironmentId;
  readonly url: URL;
}

/**
 * Which environment serves a play link: `preferred` first (the thread the link
 * was tapped in), then any other. Null for anything but a play page on one of
 * their addresses, so nothing else ever opens in a play view.
 */
export function resolvePlayLink<EnvironmentId extends string>(
  href: string,
  environments: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>,
  preferred?: EnvironmentId | null,
): PlayLinkRequest<EnvironmentId> | null {
  const url = parsePlayLink(href);
  if (url === null) return null;
  const candidates = [
    ...(preferred != null && environments.has(preferred) ? [preferred] : []),
    ...environments.keys(),
  ];
  const environmentId = candidates.find((id) => environments.get(id)?.includes(url.origin));
  return environmentId === undefined ? null : { environmentId, url };
}

/** The play page at `origin` (default: the link's own) with `ticket` in its fragment. */
export function playLinkWithTicket(url: URL, ticket: string, origin = url.origin): string {
  const next = new URL(`${url.pathname}${url.search}`, origin);
  next.hash = `ticket=${encodeURIComponent(ticket)}`;
  return next.toString();
}

/**
 * Whether a session may mint play tickets: the proxy wants the operate scope.
 * Unknown (not loaded yet) counts as yes; the server has the last word.
 */
export function sessionMayMintPlayTicket(session: AuthSessionState | null): boolean {
  if (session === null) return true;
  return session.authenticated && (session.scopes ?? []).includes(AuthOrchestrationOperateScope);
}

const withoutTrailingSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * An environment's play server as the client knows it: "checking" until the
 * first answer after connecting, then the repository it serves or "absent"
 * (no play route, or the play server is not running).
 */
export type PlayServerState =
  | { readonly status: "checking" }
  | { readonly status: "serving"; readonly repository: string }
  | { readonly status: "absent" };

export const PLAY_SERVER_CHECKING: PlayServerState = { status: "checking" };

/** A thread's "Play web build": loading while unknown, or ready with its page. */
export type ThreadPlayState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string };

/**
 * Whether a thread shows "Play web build", and its page: null (no button) for
 * a thread without a project, or once the play server is known not to serve
 * the thread's repository.
 */
export function threadPlayState(input: {
  readonly httpBaseUrl: string | null;
  readonly playServer: PlayServerState;
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
}): ThreadPlayState | null {
  const { playServer, projectRoot } = input;
  if (projectRoot === null || playServer.status === "absent") return null;
  if (playServer.status === "checking" || input.httpBaseUrl === null) return { status: "loading" };
  const url = threadPlayPageUrl({
    httpBaseUrl: input.httpBaseUrl,
    playRepository: playServer.repository,
    projectRoot,
    worktreePath: input.worktreePath,
  });
  return url === null ? null : { status: "ready", url };
}

/**
 * A thread's "Play web build" page: the play server's redirect to the build of
 * the thread's worktree (the project's checkout when it has none). Null for
 * threads of any repository but the one the environment's play server serves.
 * The play server's page explains a missing, stale or failed build.
 */
export function threadPlayPageUrl(input: {
  readonly httpBaseUrl: string;
  readonly playRepository: string | null;
  readonly projectRoot: string | null;
  readonly worktreePath: string | null;
}): string | null {
  const { playRepository, projectRoot } = input;
  if (playRepository === null || projectRoot === null) return null;
  if (withoutTrailingSlash(projectRoot) !== withoutTrailingSlash(playRepository)) return null;
  const url = new URL("/play/__open", input.httpBaseUrl);
  url.searchParams.set("path", input.worktreePath ?? projectRoot);
  return url.toString();
}
