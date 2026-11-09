import "server-only";
import { and, asc, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { loomLinkAt, type ChunkLocator } from "@mattertest/core";
import { clientQuestions, requirements, runs, scenarios, sourceChunks, sources, tasks, testCases, testPlans } from "@mattertest/db";
import { db } from "@/lib/server";

export type SourceRow = typeof sources.$inferSelect;
export type RequirementRow = typeof requirements.$inferSelect;
export type PlanRow = typeof testPlans.$inferSelect;
export type ScenarioRow = typeof scenarios.$inferSelect;
export type TestCaseRow = typeof testCases.$inferSelect;
export type QuestionRow = typeof clientQuestions.$inferSelect;

/** Display name of a source: a Loom video's title once known, else the file name. */
export const sourceTitle = (s: Pick<SourceRow, "name" | "meta">) => s.meta.title ?? s.name;

/** A project's sources, newest first; older versions of a document are left out. */
export async function projectSources(projectId: string): Promise<SourceRow[]> {
  return db.select().from(sources).where(and(eq(sources.projectId, projectId), ne(sources.status, "superseded"))).orderBy(desc(sources.createdAt));
}

/** Requirements that feed the plan (not superseded by a newer source version). */
export async function liveRequirements(projectId: string): Promise<RequirementRow[]> {
  return db
    .select()
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), ne(requirements.reviewState, "superseded")))
    .orderBy(asc(requirements.key));
}

export type PlanTree = { plan: PlanRow; scenarios: (ScenarioRow & { cases: TestCaseRow[] })[] };

/** The newest plan that hasn't been superseded, with its scenarios and test cases. */
export async function currentPlan(projectId: string): Promise<PlanTree | null> {
  const [plan] = await db
    .select()
    .from(testPlans)
    .where(and(eq(testPlans.projectId, projectId), ne(testPlans.status, "superseded")))
    .orderBy(desc(testPlans.version))
    .limit(1);
  if (!plan) return null;
  const scen = await db.select().from(scenarios).where(eq(scenarios.planId, plan.id)).orderBy(asc(scenarios.position));
  const cases = scen.length ? await db.select().from(testCases).where(inArray(testCases.scenarioId, scen.map((s) => s.id))).orderBy(asc(testCases.key)) : [];
  return { plan, scenarios: scen.map((s) => ({ ...s, cases: cases.filter((c) => c.scenarioId === s.id) })) };
}

export async function projectQuestions(projectId: string): Promise<QuestionRow[]> {
  return db.select().from(clientQuestions).where(eq(clientQuestions.projectId, projectId)).orderBy(sql`${clientQuestions.status} = 'open' desc`, asc(clientQuestions.createdAt));
}

export type AgentRun = {
  id: string;
  kind: string;
  title: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  summary: Record<string, unknown> | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sourceId: string | null;
};

/** Recent ingest and plan runs for a project, newest first. */
export async function agentRuns(projectId: string, limit = 10): Promise<AgentRun[]> {
  const rows = await db
    .select({
      id: runs.id,
      kind: tasks.kind,
      title: tasks.title,
      status: runs.status,
      createdAt: runs.createdAt,
      startedAt: runs.startedAt,
      finishedAt: runs.finishedAt,
      summary: runs.summary,
      costUsd: runs.costUsd,
      inputTokens: runs.inputTokens,
      outputTokens: runs.outputTokens,
      sourceId: sql<string | null>`${tasks.params}->>'sourceId'`,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(eq(tasks.projectId, projectId), inArray(tasks.kind, ["ingest", "plan"])))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }));
}

/** Agent spend across all projects since the start of this month (local time), and the monthly budget. */
export async function agentSpendThisMonth(): Promise<{ spent: number; budget: number }> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const [row] = await db
    .select({ spent: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(and(inArray(tasks.kind, ["ingest", "plan", "sanity", "triage"]), gte(runs.createdAt, start)));
  return { spent: Number(row?.spent ?? 0), budget: Number(process.env.AGENT_MONTHLY_BUDGET_USD || 150) };
}

/** How many items wait in a project's Review inbox. */
export async function reviewCount(projectId: string): Promise<number> {
  const tree = await currentPlan(projectId);
  const cases = tree ? tree.scenarios.reduce((n, s) => n + s.cases.filter((c) => c.reviewState === "needs-review").length, 0) : 0;
  const plan = tree?.plan.status === "draft" ? 1 : 0;
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.reviewState, "needs-review")));
  return cases + plan + (r?.n ?? 0);
}

export type Passage = {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sectionPath: string | null;
  locator: ChunkLocator;
  text: string;
  /** Where "open source" goes: the source view, or the Loom video at that moment. */
  href: string;
  videoHref: string | null;
};

/** Source passages by chunk id, in the order given. */
export async function passages(ids: string[]): Promise<Passage[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const rows = await db
    .select({ c: sourceChunks, s: { id: sources.id, name: sources.name, meta: sources.meta, type: sources.type, uri: sources.uri } })
    .from(sourceChunks)
    .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
    .where(inArray(sourceChunks.id, unique));
  const byId = new Map(rows.map((r) => [r.c.id, r]));
  return unique.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const videoHref = r.s.type === "loom" && r.s.uri ? loomLinkAt(r.s.uri, r.c.locator.startSec) : null;
    return [{
      id,
      sourceId: r.s.id,
      sourceName: sourceTitle(r.s),
      sourceType: r.s.type,
      sectionPath: r.c.sectionPath,
      locator: r.c.locator,
      text: r.c.text,
      href: `/sources/${r.s.id}?hl=${id}#chunk-${id}`,
      videoHref,
    }];
  });
}

/** "Checkout-PRD.pdf · 5.2 Promo codes · p. 12" */
export function passageLabel(p: Pick<Passage, "sourceName" | "sectionPath" | "locator">): string {
  return [p.sourceName, p.sectionPath, p.locator.page && !p.sectionPath?.startsWith("Page") ? `p. ${p.locator.page}` : null].filter(Boolean).join(" · ");
}
