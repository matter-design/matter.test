import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { authConfig, DEV_USER, SESSION_COOKIE, verifySession, type SessionUser } from "./session";

/** The signed-in user for this request, or null. */
export async function currentUser(): Promise<SessionUser | null> {
  const c = authConfig();
  if (c.disabled) return DEV_USER;
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, c.secret, c.domain);
}

/**
 * Every server action and route handler calls this, not just the proxy: server actions are
 * public POST endpoints, and Next.js recommends checking auth inside each one.
 */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
