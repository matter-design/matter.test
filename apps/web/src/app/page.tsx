import Link from "next/link";
import { Shell } from "@/components/Shell";
import { RunStatus } from "@/components/badges";
import { listProjects, recentActivity } from "@/lib/queries";
import { TRIGGER_LABEL, plural, timeAgo } from "@/lib/format";
import { ProjectsBrowser } from "./ProjectsBrowser";
import { NewProjectButton } from "./NewProjectDialog";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { "site-check": "Site check", ingest: "Read source", plan: "Test plan" };

export default async function ProjectsPage() {
  const [cards, activity] = await Promise.all([listProjects(), recentActivity(8)]);
  const active = cards.filter((c) => c.status === "active").length;
  const running = activity.filter((a) => a.status === "running" || a.status === "queued").length;

  return (
    <Shell active="projects">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p className="muted" style={{ margin: 0 }}>
            {plural(active, "active client project")}
            {running ? ` · ${plural(running, "check")} running or queued` : ""}
          </p>
        </div>
        <div className="row">
          <NewProjectButton />
        </div>
      </div>

      <ProjectsBrowser cards={cards.map((c) => ({ ...c, lastCheck: c.lastCheck ? { status: c.lastCheck.status, at: c.lastCheck.at.toISOString() } : null }))} />

      <section className="section">
        <h2>Recent activity</h2>
        <div className="table-wrap">
          <table style={{ minWidth: 720 }}>
            <thead>
              <tr><th>Task</th><th>Project</th><th>Kind</th><th>Trigger</th><th>Status</th><th>When</th></tr>
            </thead>
            <tbody>
              {activity.map((a) => (
                <tr key={a.id}>
                  <td><Link className="cell-link" href={a.kind === "ingest" || a.kind === "plan" ? `/projects/${a.projectId}/assets` : a.status === "done" ? `/runs/${a.id}` : `/projects/${a.projectId}`}>{a.title}</Link></td>
                  <td>{a.projectName}</td>
                  <td className="muted">{KIND_LABEL[a.kind] ?? a.kind}</td>
                  <td className="muted">{TRIGGER_LABEL[a.trigger] ?? a.trigger}</td>
                  <td><RunStatus status={a.status} /></td>
                  <td className="muted">{timeAgo(a.finishedAt ?? a.createdAt)}</td>
                </tr>
              ))}
              {activity.length === 0 && <tr><td colSpan={6} className="muted">Nothing has run yet. Set up a project to start its first check.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </Shell>
  );
}
