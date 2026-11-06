import type { Metadata } from "next";
import Link from "next/link";
import { currentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = { title: "MatterTest", description: "Internal agentic test management" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="sidebar" aria-label="Main">
            <Link href="/" className="brand">MatterTest</Link>
            {user && <Link href="/">All projects</Link>}
            {user && (
              <div className="whoami">
                <span title={user.email}>{user.name ?? user.email}</span>
                <form action="/auth/logout" method="post">
                  <button type="submit" className="linklike">Sign out</button>
                </form>
              </div>
            )}
          </nav>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
