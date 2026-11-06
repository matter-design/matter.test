import { describe, expect, it } from "vitest";
import { authConfig, authProblems, isAllowedGoogleUser, safeNext, signSession, verifySession } from "@/lib/session";

const secret = new TextEncoder().encode("x".repeat(40));
const other = new TextEncoder().encode("y".repeat(40));
const domain = "matterdesign.com.au";
const user = { sub: "123", email: "pat@matterdesign.com.au", name: "Pat" };

describe("session cookie", () => {
  it("round-trips a signed session", async () => {
    expect(await verifySession(await signSession(user, secret), secret, domain)).toEqual(user);
  });
  it("rejects tampered, foreign-secret and expired tokens", async () => {
    const token = await signSession(user, secret);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ email: "boss@matterdesign.com.au", sub: "1", iss: "mattertest", exp: 9e9 })).toString("base64url");
    expect(await verifySession(`${h}.${forged}.${s}`, secret, domain)).toBeNull();
    expect(await verifySession(token, other, domain)).toBeNull();
    const old = await signSession(user, secret, Date.now() - 13 * 3600 * 1000);
    expect(await verifySession(old, secret, domain)).toBeNull();
    expect(await verifySession(undefined, secret, domain)).toBeNull();
    expect(await verifySession(`${h}.${p}`, secret, domain)).toBeNull();
  });
  it("drops sessions from another domain once the allowed domain changes", async () => {
    const token = await signSession(user, secret);
    expect(await verifySession(token, secret, "other.com")).toBeNull();
  });
});

describe("who may sign in", () => {
  const base = { sub: "1", email: "pat@matterdesign.com.au", email_verified: true, hd: "matterdesign.com.au" };
  it("allows verified accounts in the company Workspace", () => {
    expect(isAllowedGoogleUser(base, domain)).toBe(true);
    expect(isAllowedGoogleUser({ ...base, email: "Pat@MatterDesign.com.au", hd: "MatterDesign.com.au" }, domain)).toBe(true);
  });
  it("refuses unverified, other-domain, look-alike and personal accounts", () => {
    expect(isAllowedGoogleUser({ ...base, email_verified: false }, domain)).toBe(false);
    expect(isAllowedGoogleUser({ ...base, email: "pat@gmail.com", hd: undefined }, domain)).toBe(false);
    expect(isAllowedGoogleUser({ ...base, email: "pat@evilmatterdesign.com.au", hd: "evilmatterdesign.com.au" }, domain)).toBe(false);
    // A personal Google account registered with a company address has no hd claim.
    expect(isAllowedGoogleUser({ ...base, hd: undefined }, domain)).toBe(false);
  });
});

describe("config", () => {
  it("never lets AUTH_DISABLED switch sign-in off in production", () => {
    expect(authConfig({ AUTH_DISABLED: "1", NODE_ENV: "development" }).disabled).toBe(true);
    expect(authConfig({ AUTH_DISABLED: "1", NODE_ENV: "production" }).disabled).toBe(false);
  });
  it("rejects short secrets and lists what is missing", () => {
    expect(authProblems(authConfig({ AUTH_SECRET: "short" }))).toEqual(["AUTH_SECRET (at least 32 characters)", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(authProblems(authConfig({ AUTH_SECRET: "z".repeat(32), GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }))).toEqual([]);
  });
});

describe("post-login redirect", () => {
  it("only allows same-site relative paths", () => {
    expect(safeNext("/projects/abc?x=1")).toBe("/projects/abc?x=1");
    for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "", null, undefined]) expect(safeNext(bad)).toBe("/");
  });
});
