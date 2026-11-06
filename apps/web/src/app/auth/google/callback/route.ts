import { decodeIdToken, Google } from "arctic";
import { cookies } from "next/headers";
import { authConfig, authProblems, isAllowedGoogleUser, safeNext, SESSION_COOKIE, SESSION_HOURS, signSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const fail = (appUrl: string, reason: string) => Response.redirect(`${appUrl}/login?error=${reason}`, 302);

/** Google redirects back here. Check state, exchange the code (PKCE), check the account, set the session. */
export async function GET(req: Request) {
  const c = authConfig();
  if (authProblems(c).length) return new Response("Sign-in is not configured.", { status: 500 });

  const params = new URL(req.url).searchParams;
  const jar = await cookies();
  const state = jar.get("mt_oauth_state")?.value;
  const verifier = jar.get("mt_oauth_verifier")?.value;
  const next = safeNext(jar.get("mt_oauth_next")?.value);
  for (const n of ["mt_oauth_state", "mt_oauth_verifier", "mt_oauth_next"]) jar.delete({ name: n, path: "/auth" });

  const code = params.get("code");
  if (!code || !state || !verifier || params.get("state") !== state) return fail(c.appUrl, "state");

  let claims: Record<string, unknown>;
  try {
    const google = new Google(c.clientId!, c.clientSecret!, `${c.appUrl}/auth/google/callback`);
    const tokens = await google.validateAuthorizationCode(code, verifier);
    // The ID token comes straight from Google's token endpoint over TLS, so its claims can be read without re-verifying the signature.
    claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
  } catch {
    return fail(c.appUrl, "google");
  }
  if (!isAllowedGoogleUser(claims, c.domain)) return fail(c.appUrl, "domain");

  const token = await signSession({ sub: String(claims.sub), email: String(claims.email), name: typeof claims.name === "string" ? claims.name : undefined }, c.secret!);
  jar.set(SESSION_COOKIE, token, { httpOnly: true, secure: c.appUrl.startsWith("https://"), sameSite: "lax", path: "/", maxAge: SESSION_HOURS * 3600 });
  return Response.redirect(`${c.appUrl}${next}`, 302);
}
