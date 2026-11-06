import "server-only";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { CheckCategory, Platform } from "@mattertest/core";
import { checkResults, clients, environments, findings, projects, runs, tasks } from "@mattertest/db";
import { perfFromCheckResults, type ReportInput } from "@mattertest/report";
import { db } from "@/lib/server";

const RUNNABLE: CheckCategory[] = ["crawl", "links", "seo", "performance", "accessibility", "security", "platform"];

export type ReportLookup =
  | { ok: true; input: ReportInput; fileName: string }
  | { ok: false; status: 404 | 409; message: string };

/**
 * Gather everything the client report needs for one finished site-check run.
 *
 * Findings are deduped across runs and only remember the last run they were seen in,
 * so a report is only accurate for the project's latest finished site check. Older runs are refused
 * rather than silently under-reporting.
 */
export async function loadReportInput(runId: string): Promise<ReportLookup> {
  const [row] = await db
    .select({ run: runs, task: tasks, project: projects, client: clients, env: environments })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(environments, eq(environments.id, runs.environmentId))
    .where(eq(runs.id, runId));
  if (!row || row.task.kind !== "site-check") return { ok: false, status: 404, message: "Site-check run not found." };
  if (row.run.status !== "done") return { ok: false, status: 409, message: "This run has not finished yet." };

  const [latest] = await db
    .select({ id: runs.id })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, row.project.id), eq(tasks.kind, "site-check"), eq(runs.status, "done")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  if (latest?.id !== runId) return { ok: false, status: 409, message: "Reports can only be generated for the latest finished site check of a project." };

  const [earlier] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, row.project.id), eq(tasks.kind, "site-check"), eq(runs.status, "done"), lt(runs.createdAt, row.run.createdAt)));
  const hasPrevious = (earlier?.n ?? 0) > 0;

  // Seen in this run, not dismissed. Accepted-risk items are left out of the client report on purpose.
  const found = await db
    .select()
    .from(findings)
    .where(and(eq(findings.projectId, row.project.id), eq(findings.lastRunId, runId), inArray(findings.state, ["new", "open"])));

  const perfRows = await db
    .select({ url: checkResults.url, metric: checkResults.metric, value: checkResults.value })
    .from(checkResults)
    .where(and(eq(checkResults.runId, runId), eq(checkResults.category, "performance")));

  const summary = (row.run.summary ?? {}) as { platform?: Platform; pages?: number; templates?: Record<string, number>; possiblyFixed?: number };
  const params = row.task.params as { categories?: CheckCategory[]; perfThrottle?: "mobile" | "desktop" | "none" };
  const finishedAt = row.run.finishedAt ?? row.run.createdAt;

  const input: ReportInput = {
    client: { name: row.client.name, branding: row.client.branding },
    project: { name: row.project.name },
    environment: { name: row.env?.name, baseUrl: row.env?.baseUrl ?? found[0]?.url ?? "" },
    run: { id: row.run.id, finishedAt },
    platform: summary.platform ?? row.project.platform,
    pagesChecked: summary.pages ?? 0,
    templates: summary.templates ?? {},
    categoriesRun: (params.categories ?? RUNNABLE).filter((c) => RUNNABLE.includes(c)),
    perf: perfFromCheckResults(perfRows),
    perfProfile: params.perfThrottle ?? "mobile",
    possiblyFixed: hasPrevious ? summary.possiblyFixed : undefined,
    findings: found.map((f) => ({
      category: f.category,
      rule: f.rule,
      severity: f.severity,
      title: f.title,
      url: f.url,
      detail: f.detail ?? undefined,
      wcag: f.wcag ?? undefined,
      selector: f.selector ?? undefined,
      evidence: f.evidence ?? undefined,
      isNew: hasPrevious && f.firstRunId === runId,
    })),
  };
  const slug = `${row.client.slug}-${row.project.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return { ok: true, input, fileName: `${slug}-health-check-${finishedAt.toISOString().slice(0, 10)}.pdf` };
}
