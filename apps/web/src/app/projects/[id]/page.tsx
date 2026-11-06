import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { environments, findings, projects, runs, tasks } from "@mattertest/db";
import { db } from "@/lib/server";
import { acceptVisualChange, startSiteCheck } from "@/app/actions";

export const dynamic = "force-dynamic";

const SEVERITY_ORDER = sql`array_position(array['critical','high','medium','low','info']::severity[], ${findings.severity})`;

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [project] = await db.select().from(projects).where(eq(projects.id, id));
  if (!project) notFound();

  const envs = await db.select().from(environments).where(eq(environments.projectId, id));
  const recentRuns = await db
    .select({ id: runs.id, status: runs.status, kind: tasks.kind, title: tasks.title, createdAt: runs.createdAt, summary: runs.summary })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(tasks.projectId, id))
    .orderBy(desc(runs.createdAt))
    .limit(10);
  // Reports are only accurate for the latest finished site check (findings remember their last run).
  const latestDone = recentRuns.find((r) => r.status === "done" && r.kind === "site-check");
  const open = await db
    .select()
    .from(findings)
    .where(sql`${findings.projectId} = ${id} and ${inArray(findings.state, ["new", "open"])}`)
    .orderBy(SEVERITY_ORDER, findings.category)
    .limit(200);

  return (
    <>
      <div>
        <p className="muted"><Link href="/">Projects</Link> / {project.name}</p>
        <div className="row"><h1>{project.name}</h1><span className="pill">{project.platform}</span></div>
      </div>

      <section className="card">
        <h2>Run a site check</h2>
        <form action={startSiteCheck} className="row" style={{ marginTop: 12 }}>
          <label className="muted" htmlFor="env">Environment</label>
          <select id="env" name="environmentId" className="input">
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name} · {e.baseUrl}</option>)}
          </select>
          <label className="muted" htmlFor="max">Max pages</label>
          <input id="max" name="maxPages" type="number" defaultValue={200} min={1} max={5000} className="input" style={{ width: 110 }} />
          <button type="submit" className="btn" disabled={!envs.length}>Start check</button>
        </form>
      </section>

      <section>
        <h2>Recent runs</h2>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Task</th><th>Status</th><th>Summary</th><th>Started</th><th>Report</th></tr></thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={r.id}>
                  <td>{r.title}</td>
                  <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                  <td className="muted">{r.summary ? `${(r.summary as { pages?: number }).pages ?? "–"} pages · ${(r.summary as { findings?: number }).findings ?? "–"} findings` : "–"}</td>
                  <td className="muted">{r.createdAt.toLocaleString("en-AU")}</td>
                  <td>{r.id === latestDone?.id ? <a href={`/runs/${r.id}/report`} download>Client PDF</a> : <span className="muted">–</span>}</td>
                </tr>
              ))}
              {recentRuns.length === 0 && <tr><td colSpan={5} className="muted">No runs yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Open findings ({open.length})</h2>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table>
            <thead><tr><th>Severity</th><th>Finding</th><th>Category</th><th>Seen</th></tr></thead>
            <tbody>
              {open.map((f) => (
                <tr key={f.id}>
                  <td><span className={`pill ${f.severity}`}>{f.severity}</span></td>
                  <td>
                    <strong>{f.title}</strong>
                    <div className="muted">{f.url}{f.wcag ? ` · WCAG ${f.wcag}` : ""}</div>
                    {f.rule === "visual.changed" && <VisualChange findingId={f.id} evidence={f.evidence} />}
                  </td>
                  <td className="muted">{f.category}</td>
                  <td className="muted">{f.occurrences}×</td>
                </tr>
              ))}
              {open.length === 0 && <tr><td colSpan={4} className="muted">Nothing open.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/** Before / now / diff thumbnails for a visual change, with an approve button. */
function VisualChange({ findingId, evidence }: { findingId: string; evidence: Record<string, unknown> | null }) {
  const ev = (evidence ?? {}) as { baselineUri?: string; currentUri?: string; diffUri?: string };
  const img = (uri: string | undefined, label: string) =>
    uri ? (
      <a href={`/artefacts/${uri}`} target="_blank" rel="noreferrer" className="shot">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/artefacts/${uri}`} alt={label} loading="lazy" />
        <span>{label}</span>
      </a>
    ) : null;
  return (
    <div className="visual-change">
      <div className="shots">{img(ev.baselineUri, "Approved")}{img(ev.currentUri, "Now")}{img(ev.diffUri, "Diff")}</div>
      {ev.currentUri && (
        <form action={acceptVisualChange}>
          <input type="hidden" name="findingId" value={findingId} />
          <button type="submit" className="btn btn-secondary">Approve change</button>
        </form>
      )}
    </div>
  );
}
