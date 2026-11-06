import { and, eq, sql } from "drizzle-orm";
import { findingFingerprint, type FindingInput } from "@mattertest/core";
import { checkResults, findings, pages, projects, runs, tasks, type Db } from "@mattertest/db";
import { rate, type SiteCheckResult } from "@mattertest/checks";

/**
 * Store a site-check result. Findings are upserted by fingerprint so the same issue
 * stays one row across runs (occurrences and last_run_id move forward).
 */
export async function persistSiteCheck(db: Db, runId: string, result: SiteCheckResult) {
  const [run] = await db.select({ taskId: runs.taskId }).from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, run.taskId));
  if (!task) throw new Error(`task ${run.taskId} not found`);

  await db.transaction(async (tx) => {
    if (result.pages.length) {
      await tx
        .insert(pages)
        .values(result.pages.map((p) => ({ runId, url: p.url, status: p.status, depth: p.depth, meta: p.error ? { error: p.error } : null })))
        .onConflictDoNothing();
    }

    await tx.insert(checkResults).values({
      runId,
      category: "crawl",
      url: result.pages[0]?.url ?? "",
      metric: "summary",
      value: { pages: result.pages.length, templates: result.templates, platform: result.platform },
      pass: null,
    });

    // One row per measured page and vital, so trends can be charted per URL.
    const perfRows = result.perf.flatMap((m) =>
      (["lcp", "cls", "tbt", "fcp", "ttfb"] as const)
        .filter((k) => m[k] !== null)
        .map((k) => ({ runId, category: "performance" as const, url: m.url, metric: k, value: { value: m[k], rating: rate(k, m[k]!), template: m.template, engine: m.engine }, pass: rate(k, m[k]!) === "good" })),
    );
    const weightRows = result.perf.map((m) => ({
      runId,
      category: "performance" as const,
      url: m.url,
      metric: "weight",
      value: { transferBytes: m.transferBytes, jsBytes: m.jsBytes, imageBytes: m.imageBytes, requests: m.requests, load: m.load, template: m.template },
      pass: null,
    }));
    const extraRows = result.perf.flatMap((m) => [
      ...(m.score !== null ? [{ runId, category: "performance" as const, url: m.url, metric: "lighthouse-score", value: { value: m.score, insights: m.insights, template: m.template }, pass: m.score >= 90 }] : []),
      ...(m.interaction ? [{ runId, category: "performance" as const, url: m.url, metric: "interaction", value: { value: m.interaction.latency, target: m.interaction.target, rating: rate("interaction", m.interaction.latency), template: m.template }, pass: rate("interaction", m.interaction.latency) === "good" }] : []),
    ]);
    const allPerf = [...perfRows, ...weightRows, ...extraRows];
    if (allPerf.length) await tx.insert(checkResults).values(allPerf);

    for (const f of dedupe(result.findings)) {
      const fp = findingFingerprint(f);
      await tx
        .insert(findings)
        .values({
          projectId: task.projectId,
          firstRunId: runId,
          lastRunId: runId,
          category: f.category,
          rule: f.rule,
          severity: f.severity,
          title: f.title,
          url: f.url,
          detail: f.detail,
          wcag: f.wcag,
          selector: f.selector,
          evidence: f.evidence,
          fingerprint: fp,
        })
        .onConflictDoUpdate({
          target: [findings.projectId, findings.fingerprint],
          set: {
            lastRunId: runId,
            severity: f.severity,
            title: f.title,
            detail: f.detail,
            evidence: f.evidence,
            occurrences: sql`${findings.occurrences} + 1`,
            // A finding marked fixed that shows up again is reopened.
            state: sql`CASE WHEN ${findings.state} = 'fixed' THEN 'open'::finding_state ELSE ${findings.state} END`,
            updatedAt: new Date(),
          },
        });
    }

    // Open findings from earlier runs that were not seen this time are candidates for "fixed".
    // We only flag them in the run summary; a human or fix-verifier confirms.
    const stale = await tx
      .select({ id: findings.id })
      .from(findings)
      .where(and(eq(findings.projectId, task.projectId), sql`${findings.lastRunId} <> ${runId}`, sql`${findings.state} in ('new','open')`));

    await tx
      .update(runs)
      .set({
        status: "done",
        finishedAt: new Date(),
        summary: {
          platform: result.platform,
          platformEvidence: result.platformEvidence,
          pages: result.pages.length,
          templates: result.templates,
          findings: result.findings.length,
          possiblyFixed: stale.length,
        },
      })
      .where(eq(runs.id, runId));

    if (result.platform !== "custom") {
      await tx.update(projects).set({ platform: result.platform }).where(and(eq(projects.id, task.projectId), eq(projects.platform, "custom")));
    }
  });
}

function dedupe(list: FindingInput[]): FindingInput[] {
  const seen = new Map<string, FindingInput>();
  for (const f of list) seen.set(findingFingerprint(f), f);
  return [...seen.values()];
}
