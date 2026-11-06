import { Google, generateCodeVerifier, generateState } from "arctic";
import { cookies } from "next/headers";
import { authConfig, authProblems, safeNext } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Start Google sign-in: PKCE + state, restricted to the company's Google Workspace domain. */
export async function GET(req: Request) {
  const c = authConfig();
  const missing = authProblems(c);
  if (missing.length) return new Response(`Sign-in is not configured. Missing: ${missing.join(", ")}`, { status: 500 });

  const google = new Google(c.clientId!, c.clientSecret!, `${c.appUrl}/auth/google/callback`);
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = google.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]);
  url.searchParams.set("hd", c.domain); // shows only company accounts in Google's picker (checked again on return)
  url.searchParams.set("prompt", "select_account");

  const jar = await cookies();
  const opts = { httpOnly: true, secure: c.appUrl.startsWith("https://"), sameSite: "lax" as const, path: "/auth", maxAge: 600 };
  jar.set("mt_oauth_state", state, opts);
  jar.set("mt_oauth_verifier", verifier, opts);
  jar.set("mt_oauth_next", safeNext(new URL(req.url).searchParams.get("next")), opts);
  return Response.redirect(url, 302);
}
