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

export const DraftStory = z.object({
  ref: z.string().describe("Short id for this story within the plan: S1, S2…"),
  title: z.string().describe("The user goal in a few words, e.g. 'Book a fitting at my store'"),
  actor: z.string().describe("As a … (the person, in the client's terms)"),
  want: z.string().describe("I want to … (what they're trying to do)"),
  soThat: z.string().describe("so that … (the benefit to them or the business)"),
  acceptanceCriteria: z.array(z.string()).describe("Observable conditions, as plain bullets, that show the story is done"),
  requirementKeys: z.array(z.string()).describe("Keys of the requirements this story covers, e.g. REQ-03"),
  priority: Priority,
  critical: z.boolean().describe("True if a failure would be P0 or P1"),
  criticalWhy: z.string().describe("For a critical story, what a failure would cost; otherwise empty"),
});

export const DraftScenario = z.object({
  storyRef: z.string().describe("The ref (S1, S2…) of the user story this scenario is an example of"),
  title: z.string().describe("The business scenario in a line, e.g. 'Guest shopper applies an expired promo code at checkout'"),
  actor: z.string().describe("Who is acting, in the client's terms: 'Guest shopper', 'Signed-in customer', 'Store manager'"),
  situation: z.string().describe("The business situation: what the actor is trying to do and the conditions that matter"),
  outcome: z.string().describe("The business outcome that shows it worked, or for a negative scenario that it failed safely"),
  priority: Priority,
  kind: z.enum(["happy", "negative", "edge"]).describe("happy = positive path that should succeed; negative = invalid input, broken rule or failure that must be handled; edge = limits and unusual combinations"),
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
  criticalRequirements: z
    .array(z.object({ key: z.string().describe("Requirement key, e.g. REQ-03"), why: z.string().describe("What a failure would cost: revenue, bookings, legal, data, reputation") }))
    .describe("Requirements whose failure would be P0 or P1. Each needs a negative scenario as well as a positive one"),
  stories: z.array(DraftStory).describe("The user stories, before the scenarios: usually 3 to 8 real user goals"),
  scenarios: z.array(DraftScenario),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

/** The gap-filling pass: only the scenarios that were missing. */
export const ScenarioTopUp = z.object({ scenarios: z.array(DraftScenario) });
export type ScenarioTopUp = z.infer<typeof ScenarioTopUp>;

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
export type ResolvedStory = {
  ref: string;
  title: string;
  actor: string;
  want: string;
  soThat: string;
  acceptanceCriteria: string[];
  requirementKeys: string[];
  priority: TestCaseInput["priority"];
  critical: boolean;
  criticalWhy: string | null;
};

export type ResolvedScenario = {
  /** The story's ref (S1…), or null when the scenario named a story that doesn't exist. */
  storyRef: string | null;
  title: string;
  actor: string | null;
  situation: string | null;
  outcome: string | null;
  priority: TestCaseInput["priority"];
  kind: TestCaseInput["kind"];
  requirementKeys: string[];
  testCases: ResolvedTestCase[];
};
export type PlanReport = { droppedScenarios: number; droppedTestCases: number; unknownRefs: number; unknownRequirements: number };

/**
 * Keep scenarios that cover at least one known requirement, and test cases with at least one complete step.
 * Each case is checked against core's `TestCaseInput`, the shape the review screen and later the sanity runner use.
 */
export function resolvePlan(raw: PlanDraft, requirementKeys: Set<string>, chunkRefs: ChunkRefs) {
  const stories = resolveStories(raw.stories ?? [], requirementKeys);
  const { scenarios, report } = resolveScenarios(raw.scenarios, requirementKeys, chunkRefs, new Set(stories.map((s) => s.ref)));
  const plan = {
    name: clean(raw.name) || "Test plan",
    summary: clean(raw.summary),
    scope: raw.scope.map(clean).filter(Boolean),
    outOfScope: raw.outOfScope.map(clean).filter(Boolean),
    risks: raw.risks.map((r) => ({ ...r, area: clean(r.area), why: clean(r.why) })).filter((r) => r.area),
  };
  const critical = new Map<string, string>();
  for (const c of raw.criticalRequirements ?? []) {
    const key = c.key.trim().toUpperCase();
    if (requirementKeys.has(key) && !critical.has(key)) critical.set(key, clean(c.why));
  }
  return { plan, stories, scenarios, critical: [...critical].map(([key, why]) => ({ key, why })), report };
}

/** Keep stories that cover at least one known requirement and say who, what and why; refs are made unique. */
export function resolveStories(raw: PlanDraft["stories"], requirementKeys: Set<string>): ResolvedStory[] {
  const out: ResolvedStory[] = [];
  const refs = new Set<string>();
  for (const s of raw) {
    const ref = clean(s.ref).toUpperCase();
    const keys = uniq(s.requirementKeys.map((k) => k.trim().toUpperCase())).filter((k) => requirementKeys.has(k));
    const [title, actor, want, soThat] = [s.title, s.actor, s.want, s.soThat].map(clean);
    if (!ref || refs.has(ref) || !keys.length || !actor || !want || !title) continue;
    refs.add(ref);
    out.push({
      ref,
      title,
      actor,
      want,
      soThat: soThat ?? "",
      acceptanceCriteria: uniq(s.acceptanceCriteria.map(clean).filter(Boolean)),
      requirementKeys: keys,
      priority: s.priority,
      critical: s.critical || s.priority === "P0" || s.priority === "P1",
      criticalWhy: clean(s.criticalWhy) || null,
    });
  }
  return out;
}

/** Check a list of drafted scenarios the same way: known requirements, complete steps, citations the model was shown. */
export function resolveScenarios(raw: PlanDraft["scenarios"], requirementKeys: Set<string>, chunkRefs: ChunkRefs, storyRefs: Set<string> = new Set()) {
  const report: PlanReport = { droppedScenarios: 0, droppedTestCases: 0, unknownRefs: 0, unknownRequirements: 0 };
  const scenarios: ResolvedScenario[] = [];
  for (const s of raw) {
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
    const storyRef = clean(s.storyRef ?? "").toUpperCase();
    scenarios.push({
      storyRef: storyRefs.has(storyRef) ? storyRef : null,
      title: clean(s.title),
      actor: clean(s.actor ?? "") || null,
      situation: clean(s.situation ?? "") || null,
      outcome: clean(s.outcome ?? "") || null,
      priority: s.priority,
      kind: s.kind,
      requirementKeys: known,
      testCases,
    });
  }
  return { scenarios, report };
}

/* ---------- Coverage rules ---------- */

export type CoverageGap = { key: string; missing: "positive" | "negative" };

/**
 * The default coverage every plan must meet: each requirement has a positive (happy) scenario, and each critical
 * requirement also has a negative one. Edge scenarios don't stand in for either.
 */
export function coverageGaps(requirementKeys: string[], critical: Set<string>, scenarios: Pick<ResolvedScenario, "kind" | "requirementKeys">[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const key of requirementKeys) {
    const kinds = new Set(scenarios.filter((s) => s.requirementKeys.includes(key)).map((s) => s.kind));
    if (!kinds.has("happy")) gaps.push({ key, missing: "positive" });
    if (critical.has(key) && !kinds.has("negative")) gaps.push({ key, missing: "negative" });
  }
  return gaps;
}

/** Each story needs a positive scenario, and each critical story a negative one too. Keys are story refs (S1…). */
export function storyGaps(stories: Pick<ResolvedStory, "ref" | "critical">[], scenarios: Pick<ResolvedScenario, "kind" | "storyRef">[]): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const st of stories) {
    const kinds = new Set(scenarios.filter((s) => s.storyRef === st.ref).map((s) => s.kind));
    if (!kinds.has("happy")) gaps.push({ key: st.ref, missing: "positive" });
    if (st.critical && !kinds.has("negative")) gaps.push({ key: st.ref, missing: "negative" });
  }
  return gaps;
}

/** Requirements the plan marked critical, plus any a P0 or P1 scenario covers: the model's priorities count even if it forgot to list them. */
export function criticalKeys(marked: { key: string }[], scenarios: Pick<ResolvedScenario, "priority" | "requirementKeys">[]): Set<string> {
  const keys = new Set(marked.map((c) => c.key));
  for (const s of scenarios) if (s.priority === "P0" || s.priority === "P1") for (const k of s.requirementKeys) keys.add(k);
  return keys;
}
