import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { authConfig, authProblems, safeNext } from "@/lib/session";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  domain: "That Google account is not part of the company workspace. Sign in with your company account.",
  state: "The sign-in link expired. Please try again.",
  google: "Google could not complete the sign-in. Please try again.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  if (await currentUser()) redirect(safeNext(next));
  const c = authConfig();
  const missing = authProblems(c);
  return (
    <section className="card login">
      <h1>Sign in</h1>
      <p className="muted">MatterTest is for the {c.domain} team. Sign in with your company Google account.</p>
      {error && <p className="error" role="alert">{ERRORS[error] ?? "Sign-in failed. Please try again."}</p>}
      {missing.length ? (
        <p className="error" role="alert">Sign-in is not configured yet. Set {missing.join(", ")} in the environment.</p>
      ) : (
        <a className="btn" href={`/auth/google?next=${encodeURIComponent(safeNext(next))}`}>Sign in with Google</a>
      )}
    </section>
  );
}
