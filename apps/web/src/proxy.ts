import { NextResponse, type NextRequest } from "next/server";
import { authConfig, SESSION_COOKIE, verifySession } from "@/lib/session";

/**
 * Every request needs a valid session except the sign-in pages themselves.
 * Pages redirect to /login; API-style routes (reports, screenshots) get 401.
 * Server actions and route handlers also check with requireUser(); this is the first line, not the only one.
 */
export async function proxy(req: NextRequest) {
  const c = authConfig();
  if (c.disabled) return NextResponse.next();
  const { pathname, search } = req.nextUrl;
  if (pathname === "/login" || pathname.startsWith("/auth/")) return NextResponse.next();

  const user = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, c.secret, c.domain);
  if (user) return NextResponse.next();

  const wantsPage = req.method === "GET" && !pathname.startsWith("/artefacts/") && !/\/report$/.test(pathname);
  if (!wantsPage) return new NextResponse("Sign in required", { status: 401 });
  const login = new URL("/login", req.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
