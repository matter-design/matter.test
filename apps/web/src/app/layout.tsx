import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = { title: "MatterTest", description: "Internal agentic test management" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <nav className="sidebar" aria-label="Main">
            <Link href="/" className="brand">MatterTest</Link>
            <Link href="/">All projects</Link>
          </nav>
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
