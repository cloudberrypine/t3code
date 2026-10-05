/**
 * Play links and the play cookie (fork-only, see PlayProxy.ts).
 *
 * Both are HMAC-signed with the environment's `play-proxy` secret, so
 * replacing that secret revokes every link and cookie at once.
 *
 * - A ticket signs one browser in: `v1.<exp>.<nonce>.<sig>`. It travels in a
 *   URL fragment and is redeemed once (PlayProxy keeps redeemed nonces).
 * - The cookie is `v1.<exp>.<id>.<sig>`, scoped to `/play`.
 */
import * as NodeCrypto from "node:crypto";

const TICKET_PURPOSE = "t3-play-ticket";
const COOKIE_PURPOSE = "t3-play-cookie";

export const PLAY_COOKIE_NAME = "t3_play";
export const PLAY_COOKIE_MAX_AGE_SECONDS = 90 * 24 * 60 * 60;
export const PLAY_TICKET_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const PLAY_TICKET_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

interface SignedToken {
  readonly expiresAt: number;
  readonly id: string;
}

const sign = (key: Uint8Array, purpose: string, payload: string) =>
  NodeCrypto.createHmac("sha256", key).update(`${purpose}.${payload}`).digest("base64url");

const signatureMatches = (expected: string, actual: string) => {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const make = (key: Uint8Array, purpose: string, expiresAt: number) => {
  const payload = `v1.${expiresAt}.${NodeCrypto.randomBytes(16).toString("base64url")}`;
  return `${payload}.${sign(key, purpose, payload)}`;
};

const verify = (
  key: Uint8Array,
  purpose: string,
  token: string,
  nowSeconds: number,
): SignedToken | null => {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, exp = "", id = "", signature = ""] = parts;
  if (!/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  if (!signatureMatches(sign(key, purpose, `v1.${exp}.${id}`), signature)) return null;
  const expiresAt = Number(exp);
  return expiresAt > nowSeconds ? { expiresAt, id } : null;
};

export const makeTicket = (key: Uint8Array, nowSeconds: number, ttlSeconds: number) => {
  const ttl = Math.max(60, Math.min(PLAY_TICKET_MAX_TTL_SECONDS, Math.floor(ttlSeconds)));
  const expiresAt = nowSeconds + ttl;
  return { ticket: make(key, TICKET_PURPOSE, expiresAt), expiresAt };
};

export const verifyTicket = (key: Uint8Array, ticket: string, nowSeconds: number) =>
  verify(key, TICKET_PURPOSE, ticket, nowSeconds);

export const makeCookieValue = (key: Uint8Array, nowSeconds: number) =>
  make(key, COOKIE_PURPOSE, nowSeconds + PLAY_COOKIE_MAX_AGE_SECONDS);

export const verifyCookieValue = (key: Uint8Array, value: string, nowSeconds: number) =>
  verify(key, COOKIE_PURPOSE, value, nowSeconds);

/** `Secure` only over https: plain-http loopback testing would otherwise lose the cookie. */
export const playCookieHeader = (value: string, secure: boolean, maxAgeSeconds: number) =>
  [
    `${PLAY_COOKIE_NAME}=${value}`,
    "Path=/play",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

export const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index !== -1 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
};

/** The secret as local scripts send it in `x-t3-play-key`. */
export const keyMatches = (key: Uint8Array, offered: string | undefined) => {
  if (!offered) return false;
  return signatureMatches(Buffer.from(key).toString("hex"), offered.trim());
};
