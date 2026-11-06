import { jwtVerify, SignJWT } from "jose";

/**
 * Sessions: a signed (HS256) cookie holding the Google account's email and name, valid 12 hours.
 * No server-side session store. Shared by the proxy and server code, so nothing here imports server-only modules.
 */
export const SESSION_COOKIE = "mt_session";
export const SESSION_HOURS = 12;

export interface SessionUser {
  sub: string;
  email: string;
  name?: string;
}

export interface AuthConfig {
  /** Local development only: AUTH_DISABLED=1 skips sign-in. Ignored in production. */
  disabled: boolean;
  secret?: Uint8Array;
  domain: string;
  clientId?: string;
  clientSecret?: string;
  appUrl: string;
}

export function authConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const disabled = env.AUTH_DISABLED === "1" && env.NODE_ENV !== "production";
  const raw = env.AUTH_SECRET;
  return {
    disabled,
    // Short secrets are rejected rather than silently accepted.
    secret: raw && raw.length >= 32 ? new TextEncoder().encode(raw) : undefined,
    domain: (env.AUTH_ALLOWED_DOMAIN || "matterdesign.com.au").toLowerCase().replace(/^@/, ""),
    clientId: env.GOOGLE_CLIENT_ID || undefined,
    clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    appUrl: (env.APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
  };
}

/** What is missing before sign-in can work (empty when ready). */
export function authProblems(c: AuthConfig): string[] {
  if (c.disabled) return [];
  const p: string[] = [];
  if (!c.secret) p.push("AUTH_SECRET (at least 32 characters)");
  if (!c.clientId) p.push("GOOGLE_CLIENT_ID");
  if (!c.clientSecret) p.push("GOOGLE_CLIENT_SECRET");
  return p;
}

export async function signSession(user: SessionUser, secret: Uint8Array, now = Date.now()): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.sub)
    .setIssuer("mattertest")
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(now / 1000) + SESSION_HOURS * 3600)
    .sign(secret);
}

/** The signed-in user, or null for a missing, expired, tampered or foreign token. */
export async function verifySession(token: string | undefined, secret: Uint8Array | undefined, domain: string): Promise<SessionUser | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: "mattertest", algorithms: ["HS256"] });
    const email = typeof payload.email === "string" ? payload.email : "";
    // Re-check the domain so narrowing AUTH_ALLOWED_DOMAIN takes effect without waiting for sessions to expire.
    if (!payload.sub || !email.toLowerCase().endsWith(`@${domain}`)) return null;
    return { sub: payload.sub, email, name: typeof payload.name === "string" ? payload.name : undefined };
  } catch {
    return null;
  }
}

/**
 * Google ID token claims allowed in: a verified email on the company domain, and the account must belong
 * to that Google Workspace (hd claim), so a personal Gmail with a look-alike address cannot get in.
 */
export function isAllowedGoogleUser(claims: Record<string, unknown>, domain: string): boolean {
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  return claims.email_verified === true && email.endsWith(`@${domain}`) && String(claims.hd ?? "").toLowerCase() === domain;
}

/** Only same-site relative paths are allowed as post-login destinations (no //evil.com, no https://…). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

export const DEV_USER: SessionUser = { sub: "dev", email: "dev@localhost", name: "Local development" };
