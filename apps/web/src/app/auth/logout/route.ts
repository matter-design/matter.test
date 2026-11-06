import { cookies } from "next/headers";
import { authConfig, SESSION_COOKIE } from "@/lib/session";

/** POST only, so a link or image on another site cannot sign people out. */
export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.redirect(`${authConfig().appUrl}/login`, 303);
}
