import { z } from "zod/v4";
import { TestCaseInput } from "@mattertest/core";

/*
 * What Claude returns, as structured output. The model-facing schemas stay simple (structured outputs support a
 * subset of JSON Schema); `resolveExtraction` and `resolvePlan` then check every citation against what the model
 * was actually shown and drop anything that can't be traced.
 */

const Priority = z.enum(["P0", "P1", "P2", "P3"]);

export const ExtractedRequirement = z.object({
  title: z.string().describe("A short name, e.g. 'Expired promo code error'"),
  text: z.string().describe("The requirement as one testable statement, in the client's terms"),
  area: z.string().describe("Feature area, e.g. 'Checkout', 'Promo codes'"),
  acceptanceCriteria: z.array(z.string()).describe("Observable conditions that show the requirement is met"),
  chunkIds: z.array(z.string()).describe("Ids of the passages (c1, c2…) this requirement comes from"),
});

export const ExtractedQuestion = z.object({
  question: z.string().describe("A question for the client, answerable in a sentence or two"),
  why: z.string().describe("What is missing, vague or contradictory, and where"),
  chunkIds: z.array(z.string()).describe("Ids of the passages the question is about"),
});

export const Extraction = z.object({
  requirements: z.array(ExtractedRequirement),
  questions: z.array(ExtractedQuestion),
});
export type Extraction = z.infer<typeof Extraction>;

export const DraftStep = z.object({ action: z.string(), expected: z.string() });

export const DraftTestCase = z.object({
  title: z.string(),
  preconditions: z.string(),
  testData: z.string(),
  steps: z.array(DraftStep),
  automationCandidate: z.boolean().describe("True if this is stable and valuable enough to automate as a sanity test"),
  chunkIds: z.array(z.string()).describe("Ids of the passages (c1, c2…) the steps and expected results come from"),
});

export const DraftScenario = z.object({
  title: z.string(),
  priority: Priority,
  kind: z.enum(["happy", "negative", "edge"]),
  requirementKeys: z.array(z.string()).describe("Keys of the requirements covered, e.g. REQ-03"),
  testCases: z.array(DraftTestCase),
});

export const PlanDraft = z.object({
  name: z.string().describe("Plan name, e.g. 'Checkout v2 test plan'"),
  summary: z.string().describe("Two or three sentences on what is being tested and why"),
  scope: z.array(z.string()),
  outOfScope: z.array(z.string()),
  risks: z.array(
    z.object({
      area: z.string(),
      risk: z.enum(["high", "medium", "low"]),
      why: z.string(),
      priority: Priority,
    }),
  ),
  scenarios: z.array(DraftScenario),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

/* ---------- Resolving citations ---------- */

/** Short passage refs shown to the model ("c1") → chunk ids in the database. */
export type ChunkRefs = Map<string, string>;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const uniq = <T,>(xs: T[]) => [...new Set(xs)];

function resolveRefs(refs: string[], chunkRefs: ChunkRefs): { ids: string[]; unknown: number } {
  const ids: string[] = [];
  let unknown = 0;
  for (const r of refs) {
    const id = chunkRefs.get(r.trim().toLowerCase());
    if (id) ids.push(id);
    else unknown++;
  }
  return { ids: uniq(ids), unknown };
}

export type ResolvedRequirement = { title: string; text: string; area: string | null; acceptanceCriteria: string[]; sourceChunkIds: string[] };
export type ResolvedQuestion = { question: string; why: string; sourceChunkIds: string[] };
export type ResolveReport = { droppedRequirements: number; droppedQuestions: number; unknownRefs: number };

/**
 * Keep requirements that cite at least one passage the model was shown; drop made-up passage ids and duplicates.
 * Questions may cite nothing (a gap can be about what the document *doesn't* say).
 */
export function resolveExtraction(raw: Extraction, chunkRefs: ChunkRefs) {
  const report: ResolveReport = { droppedRequirements: 0, droppedQuestions: 0, unknownRefs: 0 };
  const seen = new Set<string>();
  const requirements: ResolvedRequirement[] = [];
  for (const r of raw.requirements) {
    const { ids, unknown } = resolveRefs(r.chunkIds, chunkRefs);
    report.unknownRefs += unknown;
    const text = clean(r.text);
    const key = text.toLowerCase();
    if (!text || !ids.length || seen.has(key)) {
      report.droppedRequirements++;
      continue;
    }
    seen.add(key);
    requirements.push({
      title: clean(r.title) || text.slice(0, 80),
      text,
      area: clean(r.area) || null,
      acceptanceCriteria: uniq(r.acceptanceCriteria.map(clean).filter(Boolean)),
      sourceChunkIds: ids,
    });
  }
  const questions: ResolvedQuestion[] = [];
  const seenQ = new Set<string>();
  for (const q of raw.questions) {
    const { ids, unknown } = resolveRefs(q.chunkIds, chunkRefs);
    report.unknownRefs += unknown;
    const question = clean(q.question);
    if (!question || seenQ.has(question.toLowerCase())) {
      report.droppedQuestions++;
      continue;
    }
    seenQ.add(question.toLowerCase());
    questions.push({ question, why: clean(q.why), sourceChunkIds: ids });
  }
  return { requirements, questions, report };
}

export type ResolvedTestCase = Omit<TestCaseInput, "requirementIds" | "priority" | "kind"> & { sourceChunkIds: string[] };
export type ResolvedScenario = { title: string; priority: TestCaseInput["priority"]; kind: TestCaseInput["kind"]; requirementKeys: string[]; testCases: ResolvedTestCase[] };
export type PlanReport = { droppedScenarios: number; droppedTestCases: number; unknownRefs: number; unknownRequirements: number };

/**
 * Keep scenarios that cover at least one known requirement, and test cases with at least one complete step.
 * Each case is checked against core's `TestCaseInput`, the shape the review screen and later the sanity runner use.
 */
export function resolvePlan(raw: PlanDraft, requirementKeys: Set<string>, chunkRefs: ChunkRefs) {
  const report: PlanReport = { droppedScenarios: 0, droppedTestCases: 0, unknownRefs: 0, unknownRequirements: 0 };
  const scenarios: ResolvedScenario[] = [];
  for (const s of raw.scenarios) {
    const keys = uniq(s.requirementKeys.map((k) => k.trim().toUpperCase()));
    const known = keys.filter((k) => requirementKeys.has(k));
    report.unknownRequirements += keys.length - known.length;
    const testCases: ResolvedTestCase[] = [];
    for (const c of s.testCases) {
      const steps = c.steps.map((st) => ({ action: clean(st.action), expected: clean(st.expected) })).filter((st) => st.action && st.expected);
      const parsed = TestCaseInput.safeParse({
        title: clean(c.title),
        priority: s.priority,
        kind: s.kind,
        preconditions: c.preconditions.trim(),
        testData: c.testData.trim(),
        steps,
        automationCandidate: c.automationCandidate,
        requirementIds: known,
      });
      if (!parsed.success) {
        report.droppedTestCases++;
        continue;
      }
      const { ids, unknown } = resolveRefs(c.chunkIds, chunkRefs);
      report.unknownRefs += unknown;
      const { requirementIds: _r, priority: _p, kind: _k, ...rest } = parsed.data;
      testCases.push({ ...rest, sourceChunkIds: ids });
    }
    if (!known.length || !testCases.length || !clean(s.title)) {
      report.droppedScenarios++;
      report.droppedTestCases += testCases.length;
      continue;
    }
    scenarios.push({ title: clean(s.title), priority: s.priority, kind: s.kind, requirementKeys: known, testCases });
  }
  const plan = {
    name: clean(raw.name) || "Test plan",
    summary: clean(raw.summary),
    scope: raw.scope.map(clean).filter(Boolean),
    outOfScope: raw.outOfScope.map(clean).filter(Boolean),
    risks: raw.risks.map((r) => ({ ...r, area: clean(r.area), why: clean(r.why) })).filter((r) => r.area),
  };
  return { plan, scenarios, report };
}
