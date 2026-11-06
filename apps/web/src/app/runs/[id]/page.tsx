import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CheckCategory } from "@mattertest/core";
import { checkResults, environments, findings, runs, tasks } from "@mattertest/db";
import { perfFromCheckResults, type ReportCapture } from "@mattertest/report";
import { db } from "@/lib/server";
import { Shell } from "@/components/Shell";
import { SeverityPill, StatePill } from "@/components/badges";
import { categoriesOf, healthForRun, latestSiteCheck, projectWithClient, type RunRow } from "@/lib/queries";
import { CATEGORY_LABEL, dateTime, duration, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

const SEVERITY_ORDER = sql`array_position(array['critical','high','medium','low','info']::severity[], ${findings.severity})`;
const ms = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const rate = (v: number | null | undefined, good: number, poor: number) => (v === null || v === undefined ? "" : v <= good ? "ok" : v <= poor ? "warn" : "bad");
const BROWSER: Record<string, string> = { chromium: "Chrome", firefox: "Firefox", webkit: "Safari" };
const DEVICE: Record<string, string> = { mobile: "phone", tablet: "tablet", desktop: "desktop" };
const comboLabel = (combo: string) => {
  const [b, v] = combo.split("·");
  return `${BROWSER[b!] ?? b} · ${DEVICE[v!] ?? v}`;
};
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

export default async function RunPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ cat?: string }> }) {
  const { id } = await params;
  const { cat } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const [run] = await db
    .select({
      id: runs.id, status: runs.status, title: tasks.title, kind: tasks.kind, trigger: tasks.trigger, createdAt: runs.createdAt,
      startedAt: runs.startedAt, finishedAt: runs.finishedAt, summary: runs.summary, params: tasks.params, environmentId: runs.environmentId,
      projectId: tasks.projectId,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(eq(runs.id, id));
  if (!run || run.kind !== "site-check") notFound();
  const row = await projectWithClient(run.projectId);
  if (!row) notFound();
  const { project, client } = row;
  const [env] = run.environmentId ? await db.select().from(environments).where(eq(environments.id, run.environmentId)) : [];
  const latest = await latestSiteCheck(project.id);
  const isLatest = latest?.id === run.id;

  const checked = categoriesOf(run as RunRow);
  const health = run.status === "done" ? await healthForRun(project.id, run as RunRow) : null;
  const all = await db
    .select()
    .from(findings)
    .where(and(eq(findings.projectId, project.id), eq(findings.lastRunId, run.id), inArray(findings.state, ["new", "open", "accepted-risk"])))
    .orderBy(SEVERITY_ORDER, findings.category, findings.rule);
  const selected = checked.includes(cat as CheckCategory) ? (cat as CheckCategory) : null;
  const rows = selected ? all.filter((f) => f.category === selected) : all;
  const counted = (c: CheckCategory) => all.filter((f) => f.category === c && f.severity !== "info").length;

  const results = await db
    .select({ url: checkResults.url, metric: checkResults.metric, value: checkResults.value, category: checkResults.category })
    .from(checkResults)
    .where(and(eq(checkResults.runId, run.id), inArray(checkResults.category, ["performance", "visual"])));
  const perf = perfFromCheckResults(results.filter((r) => r.category === "performance"));
  const captures = results.filter((r) => r.metric === "capture").map((r) => r.value as unknown as ReportCapture);
  const combos = [...new Set(captures.map((c) => `${c.browser}·${c.viewport}`))];
  const capturePages = [...new Set(captures.map((c) => c.url))];

  const summary = (run.summary ?? {}) as { pages?: number; templates?: Record<string, number>; error?: string };
  const took = duration(run.startedAt, run.finishedAt);
  const showPerf = !selected || selected === "performance";
  const showVisual = !selected || selected === "visual";

  return (
    <Shell active="checks" project={{ id: project.id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href={`/projects/${project.id}`}>{project.name}</Link> / Website checks</span>
          <h1>{run.title}</h1>
          <span className="muted">
            {[env ? new URL(env.baseUrl).host : null, env?.name, dateTime(run.finishedAt ?? run.createdAt), summary.pages !== undefined ? plural(summary.pages, "page") : null, summary.templates ? plural(Object.keys(summary.templates).length, "page type") : null, took ? `took ${took}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <div className="row">
          {isLatest && run.status === "done" && <a className="btn btn-outline" href={`/runs/${run.id}/report`} download>Client report (PDF)</a>}
          <Link className="btn" href={`/projects/${project.id}`}>New check</Link>
        </div>
      </div>

      {run.status !== "done" && <p className="error" role="status">{run.status === "failed" ? `This check failed: ${summary.error ?? "no details"}` : "This check has not finished yet."}</p>}
      {run.status === "done" && !isLatest && latest && (
        <p className="note" style={{ margin: 0 }}>
          Findings are tracked against each project&apos;s latest check, so this older check may show fewer than it found at the time.{" "}
          <Link href={`/runs/${latest.id}`}>Open the latest check</Link>.
        </p>
      )}

      <section className="section">
        <h2>Categories <span className="muted" style={{ fontWeight: 400 }}>· select one to filter findings</span></h2>
        <div className="filter-cards">
          <Link className="filter-card" href={`/runs/${run.id}`} aria-current={!selected ? "true" : undefined}>
            <span className="filter-card-name">All findings</span>
            <span className="filter-card-nums"><b>{health?.overall ?? "—"}</b><span>{plural(all.filter((f) => f.severity !== "info").length, "finding")}</span></span>
          </Link>
          {checked.includes("crawl") && (
            <Link className="filter-card" href={`/runs/${run.id}?cat=crawl`} aria-current={selected === "crawl" ? "true" : undefined}>
              <span className="filter-card-name">{CATEGORY_LABEL.crawl}</span>
              <span className="filter-card-nums"><b>{summary.pages ?? "—"}</b><span>pages</span></span>
            </Link>
          )}
          {health?.categories.map((c) => (
            <Link key={c.category} className="filter-card" href={`/runs/${run.id}?cat=${c.category}`} aria-current={selected === c.category ? "true" : undefined}>
              <span className="filter-card-name">{CATEGORY_LABEL[c.category]}</span>
              <span className="filter-card-nums"><b>{c.score}</b><span>{plural(counted(c.category), "finding")}</span></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{selected ? CATEGORY_LABEL[selected] : "All findings"} · {plural(rows.length, "result")}</h2>
          <span className="muted small">Info rows are notes, not problems, and don&apos;t count towards the score.</span>
        </div>
        <div className="table-wrap">
          <table style={{ minWidth: 820 }}>
            <thead><tr><th>Severity</th><th>Finding</th><th>Category</th><th>Page</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td><SeverityPill severity={f.severity} /></td>
                  <td className="finding-cell">
                    <Link className="cell-link" href={`/findings/${f.id}`}>{f.title}</Link>
                    <div className="sub">{[f.wcag ? `WCAG ${f.wcag}` : null, f.rule].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="muted">{CATEGORY_LABEL[f.category]}</td>
                  <td className="muted" style={{ maxWidth: 280, overflowWrap: "anywhere" }}>{pathOf(f.url)}</td>
                  <td><StatePill state={f.state} /></td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={5} className="muted">Nothing found in this category.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      {showPerf && perf.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Speed by page type</h2>
            <span className="muted small">Lighthouse lab run on a simulated mid-range phone, like PageSpeed Insights</span>
          </div>
          <div className="table-wrap">
            <table style={{ minWidth: 760 }}>
              <thead><tr><th>Page type</th><th className="num">Score</th><th className="num">LCP (simulated)</th><th className="num">LCP (observed)</th><th className="num">CLS</th><th className="num">TBT</th><th className="num">Weight</th></tr></thead>
              <tbody>
                {perf.map((p) => (
                  <tr key={p.url}>
                    <td><strong>{p.template}</strong><div className="sub">{pathOf(p.url)}</div></td>
                    <td className={`num ${p.score === null ? "" : p.score >= 90 ? "ok" : p.score >= 50 ? "warn" : "bad"}`}>{p.score ?? "—"}</td>
                    <td className={`num ${rate(p.lcp, 2500, 4000)}`}>{ms(p.lcp)}</td>
                    <td className={`num ${rate(p.observedLcp, 2500, 4000)}`}>{ms(p.observedLcp)}</td>
                    <td className={`num ${rate(p.cls, 0.1, 0.25)}`}>{p.cls ?? "—"}</td>
                    <td className={`num ${rate(p.tbt, 200, 600)}`}>{ms(p.tbt)}</td>
                    <td className="num">{p.transferBytes ? `${(p.transferBytes / 1_000_000).toFixed(1)} MB` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {showVisual && captures.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Browsers and devices</h2>
            <span className="muted small">✓ matches the approved screenshot · ● first screenshot (new baseline) · ▲ changed or a problem · – not checked</span>
          </div>
          <div className="table-wrap">
            <table className="matrix" style={{ minWidth: 640 }}>
              <thead><tr><th>Page</th>{combos.map((c) => <th key={c}>{comboLabel(c)}</th>)}</tr></thead>
              <tbody>
                {capturePages.map((url) => (
                  <tr key={url}>
                    <td><strong>{captures.find((c) => c.url === url)?.template}</strong><div className="sub">{pathOf(url)}</div></td>
                    {combos.map((combo) => {
                      const c = captures.find((x) => x.url === url && `${x.browser}·${x.viewport}` === combo);
                      if (!c) return <td key={combo} className="muted">–</td>;
                      const problem = c.status === "changed" || c.status === "error" || c.overflowPx > 1 || c.jsErrors.length > 0 || c.brokenImages.length > 0;
                      const label = c.status === "blocked" ? "Not checked (bot protection)" : problem ? [c.status === "changed" && "changed", c.status === "error" && "capture failed", c.overflowPx > 1 && "sideways scroll", c.jsErrors.length && "script error", c.brokenImages.length && "broken image"].filter(Boolean).join(", ") : c.status === "match" ? "Matches" : "New baseline";
                      return (
                        <td key={combo} title={label}>
                          <span className={c.status === "blocked" ? "muted" : problem ? "bad" : "ok"} aria-label={label}>{c.status === "blocked" ? "–" : problem ? "▲" : c.status === "match" ? "✓" : "●"}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </Shell>
  );
}
