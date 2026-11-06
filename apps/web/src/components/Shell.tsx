import Link from "next/link";
import type { Platform } from "@mattertest/core";
import { currentUser } from "@/lib/auth";
import { PLATFORM_LABEL } from "@/lib/format";

export type NavKey = "projects" | "dashboard" | "checks";

export interface ShellProject {
  id: string;
  name: string;
  client: string;
  platform: Platform;
  /** Latest site-check run, for the "Website checks" link. */
  latestRunId?: string | null;
}

/**
 * App frame: dark sidebar plus the page. On project pages the sidebar shows the project and its sections.
 * Phase 3 sections (test assets, review inbox, sanity runs, heal queue) are left out until they exist.
 */
export async function Shell({ active, project, children }: { active: NavKey; project?: ShellProject; children: React.ReactNode }) {
  const user = await currentUser();
  const items: { key: NavKey; label: string; href: string }[] = [{ key: "projects", label: "All projects", href: "/" }];
  if (project) {
    items.push({ key: "dashboard", label: "Dashboard", href: `/projects/${project.id}` });
    if (project.latestRunId) items.push({ key: "checks", label: "Website checks", href: `/runs/${project.latestRunId}` });
  }

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link href="/" className="brand">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true">
            <rect x="1" y="1" width="24" height="24" rx="7" fill="#2F64F0" />
            <path d="M7 13.5l4 4 8-9" fill="none" stroke="#FFFFFF" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span>MatterTest</span>
        </Link>
        {project && (
          <div className="sidebar-project">
            <span className="eyebrow">Project</span>
            <span className="sidebar-project-name">{project.name}</span>
            <span className="sidebar-project-meta">{[project.client !== project.name ? project.client : null, PLATFORM_LABEL[project.platform]].filter(Boolean).join(" · ")}</span>
          </div>
        )}
        <div className="nav-items">
          {items.map((i) => (
            <Link key={i.key} href={i.href} className="nav-item" aria-current={i.key === active ? "page" : undefined}>
              {i.label}
            </Link>
          ))}
        </div>
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
  );
}
