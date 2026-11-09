/** Ingest → plan against a real database with the model mocked. Needs a migrated Postgres at DATABASE_URL; skipped otherwise. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PlanJob } from "@mattertest/core";
import { clientQuestions, clients, createDb, projects, requirements, runs, scenarios, sourceChunks, sources, tasks, testCases, testPlans, type Db } from "@mattertest/db";
import { Extraction, PlanDraft, type Embedder, type StructuredModel } from "@mattertest/agent";
import { runIngest, runPlan, type AgentDeps } from "../src/agent";

const hasDb = !!process.env.DATABASE_URL;
const db = hasDb ? createDb() : (undefined as never);
const brief = readFileSync(new URL("../../../packages/agent/test/fixtures/checkout-brief.md", import.meta.url));

let artefacts: string;
beforeAll(() => {
  artefacts = mkdtempSync(join(tmpdir(), "mt-agent-"));
  process.env.ARTEFACT_DIR = artefacts;
});
const created: { clientId: string; projectId: string }[] = [];
afterAll(async () => {
  if (!hasDb) return;
  for (const c of created) await removeProject(db, c.projectId, c.clientId);
  await db.$client.end();
});

/** Delete a test project and everything the agent jobs wrote for it. */
async function removeProject(d: Db, projectId: string, clientId: string) {
  await d.transaction(async (tx) => {
    await tx.delete(testPlans).where(eq(testPlans.projectId, projectId)); // cascades to scenarios and test cases
    await tx.delete(clientQuestions).where(eq(clientQuestions.projectId, projectId));
    await tx.delete(requirements).where(eq(requirements.projectId, projectId));
    await tx.delete(sources).where(eq(sources.projectId, projectId)); // cascades to chunks
    const t = await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId));
    if (t.length) await tx.delete(runs).where(inArray(runs.taskId, t.map((x) => x.id)));
    await tx.delete(tasks).where(eq(tasks.projectId, projectId));
    await tx.delete(projects).where(eq(projects.id, projectId));
    await tx.delete(clients).where(eq(clients.id, clientId));
  });
}

/** Answers extraction with two requirements citing real passages (found by text), and planning with one scenario per requirement. */
const model: StructuredModel = async (req) => {
  const refOf = (needle: string) => req.user.match(new RegExp(`<passage id="(c\\d+)"[^>]*>\\n[^<]*${needle}`))?.[1] ?? "c404";
  if (req.schema === (Extraction as unknown)) {
    const data = Extraction.parse({
      requirements: [
        { title: "Expired code error", text: "Expired promo codes show the expiry date and leave the total unchanged.", area: "Promo codes", acceptanceCriteria: ["Message under the field"], chunkIds: [refOf("This code expired")] },
        { title: "Free shipping over $99", text: "Standard shipping is free over $99 AUD, otherwise $9.95.", area: "Shipping", acceptanceCriteria: [], chunkIds: [refOf("Standard shipping is free")] },
      ],
      questions: [{ question: "What load time counts as fast on mobile?", why: "No target given", chunkIds: [refOf("load fast")] }],
    });
    return { data: data as never, usage: { inputTokens: 5000, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.036 }, model: "claude-opus-5-5" };
  }
  const keys = [...req.user.matchAll(/<requirement key="(REQ-\d+)"[^>]*passages="(c\d+)/g)].map((m) => ({ key: m[1]!, ref: m[2]! }));
  const data = PlanDraft.parse({
    name: "Checkout v2 test plan",
    summary: "One-page checkout.",
    scope: ["Checkout"],
    outOfScope: ["Gateway internals"],
    risks: [{ area: "Promo codes", risk: "high", why: "Revenue", priority: "P0" }],
    scenarios: keys.map((k) => ({
      title: `Scenario for ${k.key}`,
      priority: "P1",
      kind: "happy",
      requirementKeys: [k.key],
      testCases: [{ title: `Case for ${k.key}`, preconditions: "", testData: "", steps: [{ action: "Do the thing", expected: "It works" }], automationCandidate: false, chunkIds: [k.ref] }],
    })),
  });
  return { data: data as never, usage: { inputTokens: 9000, outputTokens: 3000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.096 }, model: "claude-opus-5-5" };
};

const embedder: Embedder = { name: "fake", dims: 1024, embed: async (texts) => texts.map((_, i) => Array.from({ length: 1024 }, (_, j) => (j === i % 1024 ? 1 : 0))) };

async function setup() {
  const [c] = await db.insert(clients).values({ name: "Northwind Outdoor", slug: `nw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  const [p] = await db.insert(projects).values({ clientId: c!.id, name: "Checkout v2", platform: "bigcommerce" }).returning();
  created.push({ clientId: c!.id, projectId: p!.id });
  return p!.id;
}

async function addSource(projectId: string, values: Partial<typeof sources.$inferInsert>) {
  const [s] = await db.insert(sources).values({ projectId, type: "md", name: "checkout-brief.md", contentHash: `h-${Math.random()}`, ...values }).returning();
  const [t] = await db.insert(tasks).values({ projectId, kind: "ingest", title: "Ingest" }).returning();
  const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
  return { sourceId: s!.id, taskId: t!.id, runId: r!.id };
}

function deps(planned: PlanJob[], f?: typeof fetch): AgentDeps {
  return { model, embedder, fetch: f, queuePlan: async (j) => void planned.push(j) };
}

describe.skipIf(!hasDb)("agent jobs", () => {
  it("ingests a document, extracts traced requirements, then drafts a plan with test cases", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "brief.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/brief.md` });
    const planned: PlanJob[] = [];

    await runIngest(db, { ...job, thenPlan: true }, deps(planned));

    const [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src!.status).toBe("ready");
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, job.sourceId)).orderBy(asc(sourceChunks.position));
    expect(chunks.length).toBeGreaterThan(5);
    expect(src!.meta.chunks).toBe(chunks.length);
    expect(chunks[0]!.embedding).toHaveLength(1024);

    const reqs = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.key));
    expect(reqs.map((r) => r.key)).toEqual(["REQ-01", "REQ-02"]);
    const cited = chunks.find((c) => c.id === reqs[0]!.sourceChunkIds[0]);
    expect(cited?.text).toContain("This code expired");
    expect(await db.select().from(clientQuestions).where(eq(clientQuestions.projectId, projectId))).toHaveLength(1);

    const [ingestRun] = await db.select().from(runs).where(eq(runs.id, job.runId));
    expect(ingestRun).toMatchObject({ status: "done", inputTokens: 5000, outputTokens: 800, costUsd: "0.0360" });

    expect(planned).toHaveLength(1);
    await runPlan(db, planned[0]!, deps([]));
    const [plan] = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId));
    expect(plan).toMatchObject({ version: 1, status: "draft", sourceIds: [job.sourceId] });
    const scen = await db.select().from(scenarios).where(eq(scenarios.planId, plan!.id));
    expect(scen.map((s) => s.requirementIds)).toEqual([["REQ-01"], ["REQ-02"]]);
    const cases = await db.select().from(testCases).where(inArray(testCases.scenarioId, scen.map((s) => s.id))).orderBy(asc(testCases.key));
    expect(cases.map((c) => c.key)).toEqual(["TC-001", "TC-002"]);
    expect(cases[0]!.sourceChunkIds).toEqual(reqs[0]!.sourceChunkIds);
    const [planRun] = await db.select().from(runs).where(eq(runs.id, planned[0]!.runId));
    expect(planRun!.status).toBe("done");
    expect((planRun!.summary as { testCases: number }).testCases).toBe(2);

    // A new version of the same document supersedes the old one; a fresh plan continues the numbering.
    writeFileSync(join(artefacts, "sources", projectId, "brief-v2.md"), Buffer.concat([brief, Buffer.from("\n\n## 8. Extra\n\nNew rule.\n")]));
    const v2 = await addSource(projectId, { fileUri: `sources/${projectId}/brief-v2.md`, version: 2 });
    const planned2: PlanJob[] = [];
    await runIngest(db, { ...v2, thenPlan: true }, deps(planned2));
    const [old] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(old!.status).toBe("superseded");
    const all = await db.select().from(requirements).where(eq(requirements.projectId, projectId)).orderBy(asc(requirements.key));
    expect(all.map((r) => [r.key, r.reviewState])).toEqual([["REQ-01", "superseded"], ["REQ-02", "superseded"], ["REQ-03", "needs-review"], ["REQ-04", "needs-review"]]);
    await runPlan(db, planned2[0]!, deps([]));
    const plans = await db.select().from(testPlans).where(eq(testPlans.projectId, projectId)).orderBy(asc(testPlans.version));
    expect(plans.map((p) => [p.version, p.status])).toEqual([[1, "superseded"], [2, "draft"]]);
    const newScen = await db.select().from(scenarios).where(eq(scenarios.planId, plans[1]!.id));
    const newCases = await db.select().from(testCases).where(inArray(testCases.scenarioId, newScen.map((s) => s.id))).orderBy(asc(testCases.key));
    expect(newCases.map((c) => c.key)).toEqual(["TC-003", "TC-004"]);
  });

  it("parks a Loom source that has no public transcript, then reads an attached one", async () => {
    const projectId = await setup();
    const link = "https://www.loom.com/share/0123456789abcdef0123456789abcdef";
    const job = await addSource(projectId, { type: "loom", name: "Loom video 01234567", uri: link });
    const privateLoom = (async (url: string | URL | Request) =>
      String(url).includes("/graphql") ? new Response(JSON.stringify({ data: { fetchVideoTranscript: { message: "Private video" } } })) : new Response("", { status: 404 })) as typeof fetch;
    const planned: PlanJob[] = [];
    await runIngest(db, { ...job, thenPlan: true }, deps(planned, privateLoom));
    let [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src).toMatchObject({ status: "needs-transcript", error: "Loom: Private video" });
    expect((await db.select().from(runs).where(eq(runs.id, job.runId)))[0]!.status).toBe("needs-review");
    expect(planned).toHaveLength(0);

    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "t.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nThis code expired on the date shown.\n\n00:00:06.000 --> 00:00:09.000\nStandard shipping is free over $99.\n\n00:00:10.000 --> 00:00:12.000\nIt should load fast.\n");
    await db.update(sources).set({ fileUri: `sources/${projectId}/t.vtt` }).where(eq(sources.id, job.sourceId));
    const [t] = await db.insert(tasks).values({ projectId, kind: "ingest", title: "Ingest transcript" }).returning();
    const [r] = await db.insert(runs).values({ taskId: t!.id }).returning();
    await runIngest(db, { taskId: t!.id, runId: r!.id, sourceId: job.sourceId, thenPlan: true }, deps(planned, privateLoom));
    [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src!.status).toBe("ready");
    expect(src!.meta).toMatchObject({ transcriptFrom: "upload", durationSec: 12 });
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, job.sourceId));
    expect(chunks[0]!.locator).toMatchObject({ startSec: 1 });
    expect(planned).toHaveLength(1);
  });

  it("marks the run failed and keeps the cost when the model call fails", async () => {
    const projectId = await setup();
    mkdirSync(join(artefacts, "sources", projectId), { recursive: true });
    writeFileSync(join(artefacts, "sources", projectId, "b.md"), brief);
    const job = await addSource(projectId, { fileUri: `sources/${projectId}/b.md` });
    const { AgentError } = await import("@mattertest/agent");
    const failing: StructuredModel = async () => {
      throw new AgentError("Claude declined to process this source.", { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0004 });
    };
    await expect(runIngest(db, { ...job, thenPlan: true }, { model: failing, embedder: null, queuePlan: async () => {} })).rejects.toThrow(/declined/);
    const [src] = await db.select().from(sources).where(eq(sources.id, job.sourceId));
    expect(src).toMatchObject({ status: "failed", error: "Claude declined to process this source." });
    const [run] = await db.select().from(runs).where(eq(runs.id, job.runId));
    expect(run).toMatchObject({ status: "failed", inputTokens: 100, costUsd: "0.0004" });
  });
});
