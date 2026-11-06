import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { clients, findings, projects } from "@mattertest/db";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      client: clients.name,
      platform: projects.platform,
      status: projects.status,
      openFindings: sql<number>`(select count(*)::int from ${findings} f where f.project_id = ${projects.id} and f.state in ('new','open'))`,
    })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .orderBy(projects.name);

  return (
    <>
      <div>
        <h1>Projects</h1>
        <p className="muted">{rows.length} projects</p>
      </div>
      <div className="grid">
        {rows.map((p) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="card" style={{ color: "inherit", textDecoration: "none" }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{p.name}</strong>
              <span className="pill">{p.platform}</span>
            </div>
            <p className="muted">{p.client} · {p.status}</p>
            <p style={{ margin: 0 }}><strong>{p.openFindings}</strong> open findings</p>
          </Link>
        ))}
        {rows.length === 0 && <p className="muted">No projects yet. Run <code>pnpm db:seed</code> to add a sample.</p>}
      </div>
    </>
  );
}
