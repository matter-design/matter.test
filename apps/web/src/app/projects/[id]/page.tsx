import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { environments, findings } from "@mattertest/db";
import { db } from "@/lib/server";
import { startSiteCheck } from "@/app/actions";
import { Shell } from "@/components/Shell";
import { RunStatus, SeverityPill } from "@/components/badges";
import { VisualChange } from "@/components/VisualChange";
import { healthForRun, latestSiteCheck, projectWithClient, recentActivity } from "@/lib/queries";
import { CATEGORY_LABEL, PLATFORM_LABEL, TRIGGER_LABEL, dateTime, duration, plural, timeAgo } from "@/lib/format";

export const dynamic = "force-dynamic";

const SEVERITY_ORDER = sql`array_position(array['critical','high','medium','low','info']::severity[], ${findings.severity})`;

export default async function ProjectDashboard({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ queue?: string }> }) {
  const { id } = await params;
  const { queue } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const row = await projectWithClient(id);
  if (!row) notFound();
  const { project, client } = row;

  const [envs, latest, runsList] = await Promise.all([
    db.select().from(environments).where(eq(environments.projectId, id)).orderBy(sql`${environments.name} = 'production' desc`, environments.createdAt),
    latestSiteCheck(id),
    recentActivity(8, id),
  ]);
  const health = latest ? await healthForRun(id, latest) : null;
  const summary = (latest?.summary ?? {}) as { pages?: number; templates?: Record<string, number> };

  const open = latest
    ? await db
        .select()
        .from(findings)
        .where(and(eq(findings.projectId, id), eq(findings.lastRunId, latest.id), inArray(findings.state, ["new", "open"]), sql`${findings.severity} <> 'info'`))
        .orderBy(SEVERITY_ORDER, desc(findings.occurrences))
    : [];
  const bySev = (s: string) => open.filter((f) => f.severity === s).length;
  // One row per issue type, worst first: what to fix first.
  const seen = new Set<string>();
  const fixFirst = open.filter((f) => !seen.has(f.rule) && seen.add(f.rule)).slice(0, 6);
  const ruleCount = (rule: string) => open.filter((f) => f.rule === rule).length;
  const visualChanges = open.filter((f) => f.rule === "visual.changed");
  const inFlight = runsList.find((r) => r.status === "running" || r.status === "queued");
  const checksHref = latest ? `/runs/${latest.id}` : null;

  return (
    <Shell active="dashboard" project={{ id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href="/">Projects</Link> / {project.name}</span>
          <div className="title-row">
            <h1>{project.name}</h1>
            <span className="pill">{PLATFORM_LABEL[project.platform]}</span>
            {project.status === "onboarding" && <span className="pill">Onboarding</span>}
          </div>
          <span className="muted">
            {client.name}
            {project.jiraKey ? ` · Jira ${project.jiraKey}` : ""}
            {project.slackChannel ? ` · Slack ${project.slackChannel}` : ""}
          </span>
        </div>
        <form action={startSiteCheck} className="row">
          <label htmlFor="db-env" className="sr-only">Environment</label>
          <select id="db-env" name="environmentId" className="input">
            {envs.map((e) => <option key={e.id} value={e.id}>{e.name[0]!.toUpperCase() + e.name.slice(1)} · {new URL(e.baseUrl).host}</option>)}
          </select>
          <input type="hidden" name="maxPages" value="200" />
          <button type="submit" className="btn" disabled={!envs.length || !!inFlight}>{inFlight ? "Check in progress" : "Run site check"}</button>
        </form>
      </div>

      {queue === "failed" && (
        <p className="error" role="alert">The project was created, but the first check could not be queued because the job queue is not reachable. Start the worker and Redis, then press Run site check.</p>
      )}

      {!latest ? (
        <section className="empty">
          {inFlight ? "The first site check is in progress. Results appear here when it finishes." : "No site check has finished yet. Press Run site check to start one."}
        </section>
      ) : (
        <>
          <div className="kpis">
            <Link className="kpi" href={checksHref!}>
              <span className="kpi-label">Health score</span>
              <span className="kpi-value">{health?.overall ?? "—"}</span>
              <span className="kpi-note">Out of 100, from the latest check</span>
            </Link>
            <Link className="kpi" href={checksHref!}>
              <span className="kpi-label">Open findings</span>
              <span className="kpi-value">{open.length}</span>
              <span className="kpi-note">{bySev("critical")} critical · {bySev("high")} high</span>
            </Link>
            <Link className="kpi" href={checksHref!}>
              <span className="kpi-label">Pages checked</span>
              <span className="kpi-value">{summary.pages ?? "—"}</span>
              <span className="kpi-note">{plural(Object.keys(summary.templates ?? {}).length, "page type")}</span>
            </Link>
            <Link className="kpi" href={checksHref!}>
              <span className="kpi-label">Last check</span>
              <span className="kpi-value" style={{ fontSize: 22 }}>{timeAgo(latest.finishedAt ?? latest.createdAt)}</span>
              <span className="kpi-note">{dateTime(latest.finishedAt ?? latest.createdAt)}{duration(latest.startedAt, latest.finishedAt) ? ` · took ${duration(latest.startedAt, latest.finishedAt)}` : ""}</span>
            </Link>
          </div>

          <section className="section">
            <div className="section-head">
              <h2>Health by category</h2>
              <span className="muted small">Latest site check · {dateTime(latest.finishedAt ?? latest.createdAt)}</span>
            </div>
            <div className="cats">
              {health?.categories.map((c) => (
                <Link key={c.category} className="cat" href={`/runs/${latest.id}?cat=${c.category}`}>
                  <div className="cat-head"><span className="cat-name">{CATEGORY_LABEL[c.category]}</span><span className="cat-score">{c.score}</span></div>
                  <div className="bar" aria-hidden="true"><span style={{ width: `${c.score}%` }} /></div>
                  <span className="muted small">
                    {c.source === "lighthouse" ? `Median Lighthouse score · ${plural(c.findings, "finding")}` : c.findings ? `${plural(c.issues, "issue type")} · ${plural(c.findings, "finding")}` : "Nothing open"}
                  </span>
                </Link>
              ))}
            </div>
          </section>

          <div className="split">
            <section className="panel">
              <div className="section-head"><h2 style={{ fontSize: 16 }}>Fix these first</h2><Link className="small" href={checksHref!} style={{ fontWeight: 600, textDecoration: "none" }}>All findings</Link></div>
              {fixFirst.map((f) => (
                <Link key={f.id} className="list-row" href={`/findings/${f.id}`}>
                  <span>
                    <span className="list-title">{f.title}</span>
                    <span className="list-sub">{CATEGORY_LABEL[f.category]}{ruleCount(f.rule) > 1 ? ` · ${ruleCount(f.rule)} pages` : ""}</span>
                  </span>
                  <SeverityPill severity={f.severity} />
                </Link>
              ))}
              {!fixFirst.length && <p className="muted" style={{ margin: 0 }}>Nothing open. </p>}
            </section>
            <section className="panel">
              <div className="section-head"><h2 style={{ fontSize: 16 }}>Recent runs</h2></div>
              {runsList.map((r) => (
                <div key={r.id} className="list-row">
                  <span>
                    {r.status === "done" ? <Link className="list-title" href={`/runs/${r.id}`} style={{ textDecoration: "none" }}>{r.title}</Link> : <span className="list-title">{r.title}</span>}
                    <span className="list-sub">{TRIGGER_LABEL[r.trigger] ?? r.trigger} · {timeAgo(r.finishedAt ?? r.createdAt)}{r.summary && (r.summary as { findings?: number }).findings !== undefined ? ` · ${plural((r.summary as { findings: number }).findings, "finding")}` : ""}</span>
                  </span>
                  <span className="row" style={{ gap: 8, flexWrap: "nowrap" }}>
                    {r.id === latest.id && <a className="small" href={`/runs/${r.id}/report`} download style={{ fontWeight: 600 }}>PDF</a>}
                    <RunStatus status={r.status} />
                  </span>
                </div>
              ))}
            </section>
          </div>

          {visualChanges.length > 0 && (
            <section className="section">
              <h2>Screenshot changes to review</h2>
              {visualChanges.map((f) => (
                <div key={f.id} className="panel">
                  <Link className="cell-link" href={`/findings/${f.id}`}>{f.title}</Link>
                  <VisualChange findingId={f.id} evidence={f.evidence} />
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </Shell>
  );
}
