import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { clients, findings, projects } from "@mattertest/db";
import { db } from "@/lib/server";
import { createProject } from "@/app/actions";

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
        {rows.length === 0 && <p className="muted">No projects yet. Add one below.</p>}
      </div>

      <section className="card">
        <h2>New project</h2>
        <p className="muted">The platform (Shopify, BigCommerce, WordPress…) is detected on the first check.</p>
        <form action={createProject} className="form-grid">
          <label>
            <span>Client</span>
            <input name="client" required className="input" placeholder="Debras" list="clients" />
            <datalist id="clients">{[...new Set(rows.map((r) => r.client))].map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label>
            <span>Project</span>
            <input name="name" required className="input" placeholder="Debras website" />
          </label>
          <label>
            <span>Site address</span>
            <input name="baseUrl" type="url" required className="input" placeholder="https://www.debras.com.au/" />
          </label>
          <label>
            <span>Environment</span>
            <select name="environment" className="input" defaultValue="production">
              <option value="production">production</option>
              <option value="staging">staging</option>
              <option value="uat">uat</option>
            </select>
          </label>
          <div><button type="submit" className="btn">Add project</button></div>
        </form>
      </section>
    </>
  );
}
