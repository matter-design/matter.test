import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, ne, sql } from "drizzle-orm";
import { findings, runs, tasks } from "@mattertest/db";
import { ruleCopy } from "@mattertest/report";
import { db } from "@/lib/server";
import { setFindingState } from "@/app/actions";
import { Shell } from "@/components/Shell";
import { SeverityPill, StatePill } from "@/components/badges";
import { VisualChange } from "@/components/VisualChange";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { CATEGORY_LABEL, dateTime, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

const IMAGE_KEYS = ["currentUri", "screenshotUri", "imageUri"] as const;
/** Evidence fields that are internal plumbing rather than something a reviewer needs to read. */
const HIDDEN_KEYS = new Set(["baselineUri", "currentUri", "diffUri", "screenshotUri", "imageUri"]);

export default async function FindingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [f] = await db.select().from(findings).where(eq(findings.id, id));
  if (!f) notFound();
  const row = await projectWithClient(f.projectId);
  if (!row) notFound();
  const { project, client } = row;

  const runDate = async (runId: string) => {
    const [r] = await db.select({ at: runs.finishedAt, created: runs.createdAt, title: tasks.title }).from(runs).innerJoin(tasks, eq(tasks.id, runs.taskId)).where(eq(runs.id, runId));
    return r ? { at: r.at ?? r.created, title: r.title } : null;
  };
  const sameRule = and(eq(findings.projectId, project.id), eq(findings.rule, f.rule), eq(findings.lastRunId, f.lastRunId), ne(findings.id, f.id));
  const [first, last, latest, samePages, [sameCount]] = await Promise.all([
    runDate(f.firstRunId),
    runDate(f.lastRunId),
    latestSiteCheck(project.id),
    db
      .select({ id: findings.id, url: findings.url })
      .from(findings)
      .where(sameRule)
      .orderBy(findings.url)
      .limit(50),
    db.select({ n: sql<number>`count(*)::int` }).from(findings).where(sameRule),
  ]);
  const others = sameCount?.n ?? 0;

  const copy = ruleCopy(f.rule, f.title, f.detail ?? undefined);
  const evidence = (f.evidence ?? {}) as Record<string, unknown>;
  const image = IMAGE_KEYS.map((k) => evidence[k]).find((v): v is string => typeof v === "string");
  const readable = Object.fromEntries(Object.entries(evidence).filter(([k]) => !HIDDEN_KEYS.has(k)));
  const isOpen = f.state === "new" || f.state === "open";

  return (
    <Shell active="checks" project={{ id: project.id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="stack">
        <span className="crumbs">
          <Link href={`/projects/${project.id}`}>{project.name}</Link> / <Link href={`/runs/${f.lastRunId}`}>{last?.title ?? "Site check"}</Link> / Finding
        </span>
        <div className="row" style={{ gap: 8 }}>
          <SeverityPill severity={f.severity} />
          <span className="pill">{CATEGORY_LABEL[f.category]}</span>
          {f.wcag && <span className="pill">WCAG 2.2 · {f.wcag}</span>}
          <StatePill state={f.state} />
        </div>
        <h1 style={{ fontSize: 26 }}>{f.title}</h1>
        <span className="muted">
          <a href={f.url} target="_blank" rel="noreferrer">{f.url}</a>
          {others ? ` · found in ${plural(others, "other place")} too` : ""}
        </span>
      </div>

      <div className="split">
        <div className="main-col">
          <section className="panel">
            <h2 style={{ fontSize: 16 }}>{copy.label !== f.title ? copy.label : "What's wrong"}</h2>
            {f.detail && <p style={{ margin: 0, lineHeight: 1.55 }}>{f.detail}</p>}
            {copy.why && copy.why !== f.detail && <p style={{ margin: 0, lineHeight: 1.55 }}><strong>Why it matters:</strong> {copy.why}</p>}
            {copy.fix && <p style={{ margin: 0, lineHeight: 1.55 }}><strong>How to fix:</strong> {copy.fix}</p>}
          </section>

          <section className="panel">
            <h2 style={{ fontSize: 16 }}>Evidence</h2>
            {f.rule === "visual.changed" ? (
              isOpen ? <VisualChange findingId={f.id} evidence={f.evidence} /> : <p className="muted" style={{ margin: 0 }}>This change was approved as the new baseline.</p>
            ) : image ? (
              <a href={`/artefacts/${image}`} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/artefacts/${image}`} alt={`Screenshot of ${f.url}`} style={{ width: "100%", maxHeight: 420, objectFit: "cover", objectPosition: "top", borderRadius: 10, border: "1px solid var(--border)" }} />
              </a>
            ) : null}
            {f.selector && (
              <div className="stack" style={{ gap: 6 }}>
                <span className="small" style={{ fontWeight: 600 }}>Element</span>
                <pre className="evidence-pre">{f.selector}</pre>
              </div>
            )}
            {Object.keys(readable).length > 0 && (
              <details>
                <summary className="small" style={{ fontWeight: 600, cursor: "pointer", minHeight: 32 }}>Raw evidence</summary>
                <pre className="evidence-pre" style={{ marginTop: 8 }}>{JSON.stringify(readable, null, 2)}</pre>
              </details>
            )}
            {!image && !f.selector && !Object.keys(readable).length && f.rule !== "visual.changed" && <p className="muted" style={{ margin: 0 }}>No extra evidence was recorded for this check.</p>}
          </section>

          {samePages.length > 0 && (
            <section className="panel">
              <h2 style={{ fontSize: 16 }}>Same issue elsewhere{others > samePages.length ? ` (first ${samePages.length} of ${others})` : ""}</h2>
              {samePages.map((s) => (
                <Link key={s.id} href={`/findings/${s.id}`} className="list-row"><span><span className="list-sub">{s.url}</span></span></Link>
              ))}
            </section>
          )}
        </div>

        <aside className="side-col">
          <section className="panel">
            <h2 style={{ fontSize: 16 }}>Triage</h2>
            {isOpen ? (
              <>
                <TriageButton id={f.id} state="ignored" label="Mark as false positive" />
                <TriageButton id={f.id} state="accepted-risk" label="Accept the risk" />
                <p className="muted small" style={{ margin: 0 }}>Accepted risks stay listed here but are left out of the client report.</p>
              </>
            ) : f.state === "fixed" ? (
              <p className="muted" style={{ margin: 0 }}>Marked fixed. It reopens on its own if a later check finds it again.</p>
            ) : (
              <TriageButton id={f.id} state="open" label="Reopen" />
            )}
          </section>
          <section className="panel">
            <h2 style={{ fontSize: 16 }}>History</h2>
            <dl className="facts">
              <dt>First seen</dt><dd>{first ? dateTime(first.at) : "—"}</dd>
              <dt>Last seen</dt><dd>{last ? <Link href={`/runs/${f.lastRunId}`}>{dateTime(last.at)}</Link> : "—"}</dd>
              <dt>Seen in</dt><dd>{plural(f.occurrences, "check")}</dd>
              <dt>Rule</dt><dd><code className="small">{f.rule}</code></dd>
            </dl>
          </section>
        </aside>
      </div>
    </Shell>
  );
}

function TriageButton({ id, state, label }: { id: string; state: "open" | "ignored" | "accepted-risk"; label: string }) {
  return (
    <form action={setFindingState}>
      <input type="hidden" name="findingId" value={id} />
      <input type="hidden" name="state" value={state} />
      <button type="submit" className="btn btn-outline" style={{ width: "100%" }}>{label}</button>
    </form>
  );
}
