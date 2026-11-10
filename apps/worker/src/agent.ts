import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { CONFLUENCE_MAX_PAGES, artefactPath, confluencePageUrl, type ConfluenceJob, type IngestJob, type PlanJob, type SourceType } from "@mattertest/core";
import {
  type Db,
  clientQuestions,
  clients,
  environments,
  projects,
  requirements,
  runs,
  scenarios,
  sourceChunks,
  sources,
  tasks,
  testCases,
  testPlans,
  userStories,
} from "@mattertest/db";
import {
  AgentError,
  ConfluenceError,
  NOT_SET_UP,
  NO_USAGE,
  NeedsTranscript,
  addUsage,
  draftPlan,
  extractRequirements,
  loadGuidelines,
  readPageTree,
  readSource,
  resolvePageId,
  type ConfluenceConfig,
  type QaGuidelines,
  type Embedder,
  type PlanInputChunk,
  type ProjectContext,
  type StructuredModel,
  type Usage,
} from "@mattertest/agent";

export type AgentDeps = {
  model: StructuredModel;
  embedder: Embedder | null;
  fetch?: typeof fetch;
  /** Matter Design's QA guidelines; defaults to reading docs/qa-guidelines.md fresh on each job. */
  guidelines?: () => Promise<QaGuidelines | null>;
  /** Confluence connection, or null when it isn't set up. */
  confluence?: ConfluenceConfig | null;
  /** Put a plan job on the queue (the worker passes the BullMQ queue; tests run it inline). */
  queuePlan: (job: PlanJob) => Promise<void>;
  log?: (msg: string) => void;
};

/** Most characters of source text shown to the planner before it falls back to only the cited passages (~150k tokens). */
const PLAN_CONTEXT_CHARS = 600_000;

async function start(db: Db, taskId: string, runId: string) {
  await db.update(runs).set({ status: "running", startedAt: new Date() }).where(eq(runs.id, runId));
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, taskId));
}

async function finish(db: Db, taskId: string, runId: string, status: "done" | "failed" | "needs-review", usage: Usage, summary: Record<string, unknown>) {
  await db
    .update(runs)
    .set({
      status,
      finishedAt: new Date(),
      summary,
      inputTokens: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd.toFixed(4),
    })
    .where(eq(runs.id, runId));
  await db.update(tasks).set({ status }).where(eq(tasks.id, taskId));
}

async function projectContext(db: Db, projectId: string, deps: AgentDeps): Promise<ProjectContext & { guidelinesVersion?: string }> {
  const [row] = await db
    .select({ project: projects.name, client: clients.name, platform: projects.platform, instructions: projects.agentInstructions })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(projects.id, projectId));
  if (!row) throw new Error("Project not found");
  const [env] = await db.select({ baseUrl: environments.baseUrl }).from(environments).where(eq(environments.projectId, projectId)).orderBy(environments.createdAt).limit(1);
  const guide = await (deps.guidelines ?? (() => loadGuidelines()))();
  return { ...row, siteUrl: env?.baseUrl ?? null, guidelines: guide?.text ?? null, guidelinesVersion: guide?.version };
}

/** Next free number for keys like REQ-07 / TC-014 in a column. */
function nextNumber(keys: string[], prefix: string): number {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  return keys.reduce((n, k) => Math.max(n, Number(k.match(re)?.[1] ?? 0)), 0) + 1;
}
const keyOf = (prefix: string, n: number, width: number) => `${prefix}-${String(n).padStart(width, "0")}`;

type Source = typeof sources.$inferSelect;

type IngestOutcome =
  | { ok: true; usage: Usage; requirements: number; questions: number; summary: Record<string, unknown> }
  | { ok: false; usage: Usage; error: string; needsTranscript: boolean; cause: unknown };

/**
 * Read, chunk, embed and extract one source, keeping its status up to date. Never throws: failures are
 * recorded on the source and returned, with whatever the model calls cost.
 */
async function ingestSource(db: Db, source: Source, deps: AgentDeps): Promise<IngestOutcome> {
  const log = deps.log ?? (() => {});
  await db.update(sources).set({ status: "ingesting", error: null }).where(eq(sources.id, source.id));
  let usage = NO_USAGE;
  try {
    const file = source.fileUri ? await readFile(artefactPath(source.fileUri)) : undefined;
    log(`reading ${source.type} source "${source.name}"`);
    const { chunks, meta } = await readSource({ type: source.type as SourceType, file, link: source.uri }, deps.fetch);
    log(`${chunks.length} chunks`);

    let vectors: number[][] | null = null;
    let embedError: string | undefined;
    if (deps.embedder) {
      try {
        vectors = await deps.embedder.embed(chunks.map((c) => (c.sectionPath ? `${c.sectionPath}\n${c.text}` : c.text)));
      } catch (e) {
        embedError = (e as Error).message;
        log(`embedding failed, storing chunks without vectors: ${embedError}`);
      }
    }

    // Re-ingesting (e.g. after a transcript is attached) replaces this source's chunks, requirements and questions.
    await db.delete(requirements).where(eq(requirements.sourceId, source.id));
    await db.delete(clientQuestions).where(eq(clientQuestions.sourceId, source.id));
    await db.delete(sourceChunks).where(eq(sourceChunks.sourceId, source.id));
    const stored = await db
      .insert(sourceChunks)
      .values(chunks.map((c, i) => ({ sourceId: source.id, position: c.position, sectionPath: c.sectionPath, locator: c.locator, text: c.text, embedding: vectors?.[i] ?? null })))
      .returning({ id: sourceChunks.id, position: sourceChunks.position });
    const idAt = new Map(stored.map((s) => [s.position, s.id]));
    const storedChunks = chunks.map((c) => ({ ...c, id: idAt.get(c.position)! }));

    const ctx = await projectContext(db, source.projectId, deps);
    log("extracting requirements");
    const extracted = await extractRequirements(deps.model, ctx, { name: meta.title ?? source.meta.title ?? source.name, type: source.type, note: source.meta.note }, storedChunks);
    usage = extracted.usage;

    const existing = await db.select({ key: requirements.key }).from(requirements).where(eq(requirements.projectId, source.projectId));
    let n = nextNumber(existing.map((r) => r.key), "REQ");
    if (extracted.requirements.length) {
      await db.insert(requirements).values(
        extracted.requirements.map((r) => ({ projectId: source.projectId, sourceId: source.id, key: keyOf("REQ", n++, 2), title: r.title, text: r.text, area: r.area, acceptanceCriteria: r.acceptanceCriteria, sourceChunkIds: r.sourceChunkIds })),
      );
    }
    if (extracted.questions.length) {
      await db.insert(clientQuestions).values(extracted.questions.map((q) => ({ projectId: source.projectId, sourceId: source.id, question: q.question, why: q.why, sourceChunkIds: q.sourceChunkIds })));
    }

    // An older version of the same document no longer feeds the plan: same link, or for uploads the same name.
    // Confluence pages match by link only, since two pages in a space can share a title.
    const sameDoc = source.uri ? (source.type === "confluence" ? eq(sources.uri, source.uri) : or(eq(sources.uri, source.uri), eq(sources.name, source.name))) : eq(sources.name, source.name);
    const older = await db
      .select({ id: sources.id })
      .from(sources)
      .where(and(eq(sources.projectId, source.projectId), ne(sources.id, source.id), sql`${sources.version} < ${source.version}`, sameDoc));
    if (older.length) {
      const ids = older.map((o) => o.id);
      await db.update(sources).set({ status: "superseded" }).where(inArray(sources.id, ids));
      await db.update(requirements).set({ reviewState: "superseded" }).where(inArray(requirements.sourceId, ids));
    }

    await db
      .update(sources)
      .set({ status: "ready", error: null, meta: { ...source.meta, ...meta, chunks: chunks.length } })
      .where(eq(sources.id, source.id));
    return {
      ok: true,
      usage,
      requirements: extracted.requirements.length,
      questions: extracted.questions.length,
      summary: {
        chunks: chunks.length,
        embedded: !!vectors,
        ...(embedError ? { embedError } : {}),
        requirements: extracted.requirements.length,
        questions: extracted.questions.length,
        dropped: extracted.report,
        model: extracted.model,
        // What the agent was told, kept with the run so a reviewer can see why the output looks the way it does.
        ...(ctx.instructions?.trim() ? { instructions: ctx.instructions.trim() } : {}),
        ...(source.meta.note ? { sourceNote: source.meta.note } : {}),
        ...(ctx.guidelinesVersion ? { guidelinesVersion: ctx.guidelinesVersion } : {}),
      },
    };
  } catch (e) {
    if (e instanceof NeedsTranscript) {
      await db.update(sources).set({ status: "needs-transcript", error: e.message }).where(eq(sources.id, source.id));
      return { ok: false, usage, error: e.message, needsTranscript: true, cause: e };
    }
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    const message = (e as Error).message;
    await db.update(sources).set({ status: "failed", error: message }).where(eq(sources.id, source.id));
    return { ok: false, usage, error: message, needsTranscript: false, cause: e };
  }
}

/** Queue a plan run after ingest, as a child of the ingest task. */
async function queuePlanAfter(db: Db, deps: AgentDeps, projectId: string, parentTaskId: string, params: Record<string, unknown>) {
  const [task] = await db.insert(tasks).values({ projectId, kind: "plan", trigger: "manual", title: "Draft test plan", params, parentTaskId }).returning();
  const [run] = await db.insert(runs).values({ taskId: task!.id }).returning();
  await deps.queuePlan({ taskId: task!.id, runId: run!.id, projectId });
}

/** Read, chunk, embed and extract one source; then queue a plan run. */
export async function runIngest(db: Db, job: IngestJob, deps: AgentDeps) {
  await start(db, job.taskId, job.runId);
  const [source] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
  if (!source) {
    await finish(db, job.taskId, job.runId, "failed", NO_USAGE, { error: "Source not found" });
    return;
  }
  const out = await ingestSource(db, source, deps);
  if (!out.ok) {
    if (out.needsTranscript) {
      await finish(db, job.taskId, job.runId, "needs-review", out.usage, { needsTranscript: true, error: out.error });
      return;
    }
    await finish(db, job.taskId, job.runId, "failed", out.usage, { error: out.error });
    throw out.cause;
  }
  await finish(db, job.taskId, job.runId, "done", out.usage, out.summary);
  if (job.thenPlan && out.requirements) await queuePlanAfter(db, deps, source.projectId, job.taskId, { sourceId: source.id });
}

/**
 * Add a Confluence page (and its child pages), or with `sync` re-check every Confluence page in the project.
 * Each page is its own source. Pages whose Confluence version hasn't changed are skipped; new and changed pages
 * are saved as HTML, ingested here one after another, and one plan run follows.
 */
export async function runConfluence(db: Db, job: ConfluenceJob, deps: AgentDeps) {
  const log = deps.log ?? (() => {});
  await start(db, job.taskId, job.runId);
  let usage = NO_USAGE;
  const counts = { pages: 0, added: 0, changed: 0, unchanged: 0, failed: 0, requirements: 0, questions: 0 };
  const problems: string[] = [];
  try {
    const cfg = deps.confluence;
    if (!cfg) throw new ConfluenceError(NOT_SET_UP);
    const f = deps.fetch ?? fetch;

    let roots: { pageId: string; includeChildren: boolean; title?: string }[];
    if (job.sync) {
      const live = await db
        .select()
        .from(sources)
        .where(and(eq(sources.projectId, job.projectId), eq(sources.type, "confluence"), ne(sources.status, "superseded")));
      const byRoot = new Map<string, { pageId: string; includeChildren: boolean; title?: string }>();
      for (const s of live) {
        const c = s.meta.confluence;
        if (!c) continue;
        const root = byRoot.get(c.rootPageId) ?? { pageId: c.rootPageId, includeChildren: false };
        if (c.pageId === c.rootPageId) Object.assign(root, { includeChildren: !!c.includeChildren, title: s.name });
        byRoot.set(c.rootPageId, root);
      }
      roots = [...byRoot.values()];
      if (!roots.length) throw new ConfluenceError("There are no Confluence pages in this project yet.");
    } else {
      if (!job.link) throw new ConfluenceError("No Confluence link was given.");
      roots = [{ pageId: await resolvePageId(cfg, job.link, f), includeChildren: job.includeChildren }];
    }

    const seen = new Set<string>();
    const toIngest: Source[] = [];
    for (const root of roots) {
      let tree: Awaited<ReturnType<typeof readPageTree>>;
      try {
        log(`reading Confluence page ${root.pageId}${root.includeChildren ? " and its child pages" : ""}`);
        tree = await readPageTree(cfg, root.pageId, { includeChildren: root.includeChildren }, f);
      } catch (e) {
        if (!job.sync || !(e instanceof ConfluenceError)) throw e;
        problems.push(`${root.title ?? `Page ${root.pageId}`}: ${e.message}`);
        continue;
      }
      if (tree.truncated) problems.push(`Only the first ${CONFLUENCE_MAX_PAGES} pages under "${tree.pages[0]!.title}" were read.`);
      for (const page of tree.pages) {
        if (seen.has(page.id)) continue;
        seen.add(page.id);
        const uri = confluencePageUrl(cfg.origin, page.id);
        const [latest] = await db
          .select()
          .from(sources)
          .where(and(eq(sources.projectId, job.projectId), eq(sources.uri, uri)))
          .orderBy(desc(sources.version))
          .limit(1);
        const isRoot = page.id === root.pageId;
        if (latest && latest.meta.confluence?.version === page.version) {
          if (latest.status === "failed") {
            toIngest.push(latest); // same content, failed last time: try it again
            counts.changed++;
          } else {
            counts.unchanged++;
          }
          continue;
        }
        if (!page.html.trim()) {
          problems.push(`${page.title}: the page is empty.`);
          continue;
        }
        const data = Buffer.from(page.html, "utf8");
        const hash = createHash("sha256").update(data).digest("hex");
        const fileUri = `sources/${job.projectId}/${hash.slice(0, 16)}-confluence-${page.id}.html`;
        await mkdir(dirname(artefactPath(fileUri)), { recursive: true });
        await writeFile(artefactPath(fileUri), data);
        const [source] = await db
          .insert(sources)
          .values({
            projectId: job.projectId,
            type: "confluence",
            name: page.title,
            uri,
            fileUri,
            contentHash: hash,
            version: (latest?.version ?? 0) + 1,
            meta: {
              title: page.title,
              // A note given when adding applies to every page read through it; a re-read keeps the page's last note.
              ...((job.note ?? latest?.meta.note) ? { note: job.note ?? latest?.meta.note } : {}),
              confluence: { pageId: page.id, version: page.version, webUrl: page.webUrl, rootPageId: root.pageId, ...(isRoot ? { includeChildren: root.includeChildren } : {}) },
            },
            createdBy: job.requestedBy ?? null,
          })
          .returning();
        if (latest) counts.changed++;
        else counts.added++;
        toIngest.push(source!);
      }
    }
    counts.pages = seen.size;

    for (const source of toIngest) {
      const out = await ingestSource(db, source, deps);
      usage = addUsage(usage, out.usage);
      if (out.ok) {
        counts.requirements += out.requirements;
        counts.questions += out.questions;
      } else {
        counts.failed++;
        problems.push(`${source.name}: ${out.error}`);
      }
    }

    const allFailed = toIngest.length > 0 && counts.failed === toIngest.length;
    await finish(db, job.taskId, job.runId, allFailed ? "failed" : "done", usage, {
      ...counts,
      ...(problems.length ? { problems } : {}),
      ...(allFailed ? { error: problems[0] } : {}),
    });
    if (counts.requirements) await queuePlanAfter(db, deps, job.projectId, job.taskId, { confluence: true });
  } catch (e) {
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    await finish(db, job.taskId, job.runId, "failed", usage, { ...counts, error: (e as Error).message, ...(problems.length ? { problems } : {}) });
    if (!(e instanceof ConfluenceError)) throw e;
  }
}

/** Draft a new plan version from the project's live requirements. */
export async function runPlan(db: Db, job: PlanJob, deps: AgentDeps) {
  const log = deps.log ?? (() => {});
  await start(db, job.taskId, job.runId);
  let usage = NO_USAGE;
  try {
    const reqs = await db
      .select({ r: requirements })
      .from(requirements)
      .innerJoin(sources, eq(sources.id, requirements.sourceId))
      .where(and(eq(requirements.projectId, job.projectId), inArray(requirements.reviewState, ["needs-review", "approved"]), eq(sources.status, "ready")))
      .orderBy(requirements.key);
    if (!reqs.length) throw new Error("There are no requirements to plan from. Add a source first.");

    const sourceIds = [...new Set(reqs.map((x) => x.r.sourceId!))];
    const all = await db
      .select({ c: sourceChunks, sourceName: sources.name, sourceType: sources.type, title: sql<string | null>`${sources.meta}->>'title'`, note: sql<string | null>`${sources.meta}->>'note'` })
      .from(sourceChunks)
      .innerJoin(sources, eq(sources.id, sourceChunks.sourceId))
      .where(inArray(sourceChunks.sourceId, sourceIds))
      .orderBy(sources.createdAt, sourceChunks.position);
    const cited = new Set(reqs.flatMap((x) => x.r.sourceChunkIds));
    const total = all.reduce((n, x) => n + x.c.text.length, 0);
    const shown = total <= PLAN_CONTEXT_CHARS ? all : all.filter((x) => cited.has(x.c.id));
    const chunks: PlanInputChunk[] = shown.map((x) => ({ ...x.c, sourceName: x.title ?? x.sourceName, sourceType: x.sourceType }));

    const questions = await db.select({ q: clientQuestions.question }).from(clientQuestions).where(and(eq(clientQuestions.projectId, job.projectId), eq(clientQuestions.status, "open")));
    const ctx = await projectContext(db, job.projectId, deps);
    log(`planning from ${reqs.length} requirements and ${chunks.length} passages`);
    const drafted = await draftPlan(
      deps.model,
      ctx,
      reqs.map((x) => ({ key: x.r.key, title: x.r.title, text: x.r.text, area: x.r.area, acceptanceCriteria: x.r.acceptanceCriteria, sourceChunkIds: x.r.sourceChunkIds })),
      chunks,
      questions.map((q) => q.q),
      [...new Map(all.filter((x) => x.note).map((x) => [x.c.sourceId, { source: x.title ?? x.sourceName, note: x.note! }])).values()],
    );
    usage = drafted.usage;

    const [prev] = await db.select({ version: testPlans.version }).from(testPlans).where(eq(testPlans.projectId, job.projectId)).orderBy(desc(testPlans.version)).limit(1);
    const keys = await db
      .select({ key: testCases.key })
      .from(testCases)
      .innerJoin(scenarios, eq(scenarios.id, testCases.scenarioId))
      .innerJoin(testPlans, eq(testPlans.id, scenarios.planId))
      .where(eq(testPlans.projectId, job.projectId));
    let tc = nextNumber(keys.map((k) => k.key), "TC");
    const storyKeys = await db
      .select({ key: userStories.key })
      .from(userStories)
      .innerJoin(testPlans, eq(testPlans.id, userStories.planId))
      .where(eq(testPlans.projectId, job.projectId));
    let us = nextNumber(storyKeys.map((k) => k.key), "US");
    // Stories get project-wide keys (US-07) in the order Claude gave them; gaps name stories by those keys too.
    const keyOfStory = new Map(drafted.stories.map((st) => [st.ref, keyOf("US", us++, 2)]));
    const gaps = drafted.plan.gaps.map((g) => ({ ...g, key: keyOfStory.get(g.key) ?? g.key }));

    const caseCount = await db.transaction(async (tx) => {
      // Earlier drafts give way to the new one; anything already approved stays approved.
      const oldPlans = await tx.select({ id: testPlans.id }).from(testPlans).where(and(eq(testPlans.projectId, job.projectId), eq(testPlans.status, "draft")));
      if (oldPlans.length) {
        const ids = oldPlans.map((p) => p.id);
        await tx.update(testPlans).set({ status: "superseded" }).where(inArray(testPlans.id, ids));
        const scen = await tx.select({ id: scenarios.id }).from(scenarios).where(inArray(scenarios.planId, ids));
        if (scen.length) await tx.update(testCases).set({ reviewState: "superseded" }).where(and(inArray(testCases.scenarioId, scen.map((s) => s.id)), eq(testCases.reviewState, "needs-review")));
      }
      const [plan] = await tx
        .insert(testPlans)
        .values({ projectId: job.projectId, taskId: job.taskId, name: drafted.plan.name, version: (prev?.version ?? 0) + 1, status: "draft", body: { summary: drafted.plan.summary, scope: drafted.plan.scope, outOfScope: drafted.plan.outOfScope, risks: drafted.plan.risks, critical: drafted.plan.critical, gaps }, sourceIds })
        .returning();
      const storyIds = new Map<string, string>();
      for (const [i, st] of drafted.stories.entries()) {
        const [row] = await tx
          .insert(userStories)
          .values({
            planId: plan!.id,
            key: keyOfStory.get(st.ref)!,
            title: st.title,
            actor: st.actor,
            want: st.want,
            soThat: st.soThat,
            acceptanceCriteria: st.acceptanceCriteria,
            requirementIds: st.requirementKeys,
            priority: st.priority,
            critical: st.critical,
            criticalWhy: st.criticalWhy,
            position: i,
          })
          .returning({ id: userStories.id });
        storyIds.set(st.ref, row!.id);
      }
      let cases = 0;
      for (const [i, s] of drafted.scenarios.entries()) {
        const [scen] = await tx.insert(scenarios).values({ planId: plan!.id, storyId: s.storyRef ? (storyIds.get(s.storyRef) ?? null) : null, title: s.title, actor: s.actor, situation: s.situation, outcome: s.outcome, priority: s.priority, kind: s.kind, requirementIds: s.requirementKeys, position: i }).returning();
        await tx.insert(testCases).values(
          s.testCases.map((c) => ({
            scenarioId: scen!.id,
            key: keyOf("TC", tc++, 3),
            title: c.title,
            preconditions: c.preconditions,
            testData: c.testData,
            steps: c.steps,
            type: "manual",
            automationCandidate: c.automationCandidate,
            sourceChunkIds: c.sourceChunkIds,
          })),
        );
        cases += s.testCases.length;
      }
      return cases;
    });

    await finish(db, job.taskId, job.runId, "done", usage, {
      requirements: reqs.length,
      scenarios: drafted.scenarios.length,
      testCases: caseCount,
      passages: chunks.length,
      stories: drafted.stories.length,
      critical: drafted.plan.critical.length,
      gapsFound: drafted.report.gapsFound,
      gapsFilled: drafted.report.gapsFilled,
      ...(gaps.length ? { gapsLeft: gaps } : {}),
      dropped: drafted.report,
      model: drafted.model,
      ...(ctx.instructions?.trim() ? { instructions: ctx.instructions.trim() } : {}),
      ...(ctx.guidelinesVersion ? { guidelinesVersion: ctx.guidelinesVersion } : {}),
    });
  } catch (e) {
    if (e instanceof AgentError) usage = addUsage(usage, e.usage);
    await finish(db, job.taskId, job.runId, "failed", usage, { error: (e as Error).message });
    throw e;
  }
}
