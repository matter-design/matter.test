import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { CheckCategory, Platform } from "@mattertest/core";
import { checkResults, clients, environments, findings, projects, runs, tasks } from "@mattertest/db";
import { db } from "@/lib/server";
import { healthScore, type Health } from "@/lib/health";

const OPEN = ["new", "open"] as const;
const RUNNABLE: CheckCategory[] = ["crawl", "links", "seo", "performance", "accessibility", "security", "platform", "visual"];

export type RunRow = {
  id: string;
  status: string;
  title: string;
  kind: string;
  trigger: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: Record<string, unknown> | null;
  params: Record<string, unknown>;
  environmentId: string | null;
};

const runColumns = {
  id: runs.id,
  status: runs.status,
  title: tasks.title,
  kind: tasks.kind,
  trigger: tasks.trigger,
  createdAt: runs.createdAt,
  startedAt: runs.startedAt,
  finishedAt: runs.finishedAt,
  summary: runs.summary,
  params: tasks.params,
  environmentId: runs.environmentId,
};

/** The most recent finished site check for a project. Findings remember only their last run, so this is the one the scores describe. */
export async function latestSiteCheck(projectId: string): Promise<RunRow | null> {
  const [row] = await db
    .select(runColumns)
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), eq(tasks.kind, "site-check"), eq(runs.status, "done")))
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row ?? null;
}

export function categoriesOf(run: Pick<RunRow, "params">): CheckCategory[] {
  const c = (run.params as { categories?: CheckCategory[] }).categories;
  return c?.length ? c : RUNNABLE;
}

/** Health of a project as of a finished site check. */
export async function healthForRun(projectId: string, run: RunRow): Promise<Health> {
  const open = await db
    .select({ category: findings.category, rule: findings.rule, severity: findings.severity })
    .from(findings)
    .where(and(eq(findings.projectId, projectId), eq(findings.lastRunId, run.id), inArray(findings.state, [...OPEN])));
  const lh = await db
    .select({ value: checkResults.value })
    .from(checkResults)
    .where(and(eq(checkResults.runId, run.id), eq(checkResults.metric, "lighthouse-score")));
  const scores = lh.map((r) => Number((r.value as { value?: number }).value)).filter((n) => Number.isFinite(n));
  return healthScore(open, categoriesOf(run), scores);
}

export type ProjectCard = {
  id: string;
  name: string;
  client: string;
  platform: Platform;
  status: string;
  domain: string | null;
  openFindings: number;
  critical: number;
  high: number;
  health: number | null;
  lastCheck: { status: string; at: Date } | null;
};

export async function listProjects(): Promise<ProjectCard[]> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      client: clients.name,
      platform: projects.platform,
      status: projects.status,
      openFindings: sql<number>`(select count(*)::int from ${findings} f where f.project_id = ${projects.id} and f.state in ('new','open') and f.severity <> 'info')`,
      critical: sql<number>`(select count(*)::int from ${findings} f where f.project_id = ${projects.id} and f.state in ('new','open') and f.severity = 'critical')`,
      high: sql<number>`(select count(*)::int from ${findings} f where f.project_id = ${projects.id} and f.state in ('new','open') and f.severity = 'high')`,
      domain: sql<string | null>`(select e.base_url from ${environments} e where e.project_id = ${projects.id} order by (e.name = 'production') desc, e.created_at limit 1)`,
    })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .orderBy(clients.name, projects.name);

  return Promise.all(
    rows.map(async (p) => {
      const [last] = await db
        .select({ status: runs.status, createdAt: runs.createdAt, finishedAt: runs.finishedAt })
        .from(runs)
        .innerJoin(tasks, eq(tasks.id, runs.taskId))
        .where(and(eq(tasks.projectId, p.id), eq(tasks.kind, "site-check")))
        .orderBy(desc(runs.createdAt))
        .limit(1);
      const done = await latestSiteCheck(p.id);
      const health = done ? (await healthForRun(p.id, done)).overall : null;
      return {
        ...p,
        domain: p.domain ? hostOf(p.domain) : null,
        health,
        lastCheck: last ? { status: last.status, at: last.finishedAt ?? last.createdAt } : null,
      };
    }),
  );
}

export type ActivityRow = RunRow & { projectId: string; projectName: string };

export async function recentActivity(limit = 8, projectId?: string): Promise<ActivityRow[]> {
  return db
    .select({ ...runColumns, projectId: projects.id, projectName: projects.name })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(projectId ? eq(projects.id, projectId) : undefined)
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

export async function projectWithClient(id: string) {
  const [row] = await db
    .select({ project: projects, client: clients })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(projects.id, id));
  return row ?? null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}
