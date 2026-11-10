import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { Extraction, PlanDraft, coverageGaps, criticalKeys, resolveExtraction, resolvePlan, resolveStories, storyGaps, type ChunkRefs } from "../src/schemas";

const refs: ChunkRefs = new Map([
  ["c1", "chunk-a"],
  ["c2", "chunk-b"],
  ["c3", "chunk-c"],
]);

const req = (over: Partial<z.infer<typeof Extraction>["requirements"][number]> = {}) => ({
  title: "Expired code error",
  text: "An expired promo code shows 'This code expired on {date}' under the field.",
  area: "Promo codes",
  acceptanceCriteria: ["Error under the field", "Total unchanged", "Total unchanged"],
  chunkIds: ["c2"],
  ...over,
});

describe("Extraction schema", () => {
  it("accepts a well-formed answer", () => {
    expect(Extraction.safeParse({ requirements: [req()], questions: [{ question: "SMS too?", why: "Speaker unsure", chunkIds: [] }] }).success).toBe(true);
  });

  it("rejects missing fields and wrong types", () => {
    expect(Extraction.safeParse({ requirements: [{ ...req(), chunkIds: "c2" }], questions: [] }).success).toBe(false);
    expect(Extraction.safeParse({ requirements: [] }).success).toBe(false);
    const { text: _t, ...noText } = req();
    expect(Extraction.safeParse({ requirements: [noText], questions: [] }).success).toBe(false);
  });

  it("produces a JSON Schema that structured outputs can use (objects closed, all fields required)", () => {
    const schema = z.toJSONSchema(Extraction) as { properties: { requirements: { items: { required: string[]; additionalProperties: boolean } } } };
    const item = schema.properties.requirements.items;
    expect(item.required).toEqual(["title", "text", "area", "acceptanceCriteria", "chunkIds"]);
    expect(item.additionalProperties).toBe(false);
  });
});

describe("resolveExtraction", () => {
  it("maps passage refs to chunk ids and drops made-up refs", () => {
    const { requirements, report } = resolveExtraction({ requirements: [req({ chunkIds: ["c2", "C1", "c99"] })], questions: [] }, refs);
    expect(requirements[0]!.sourceChunkIds).toEqual(["chunk-b", "chunk-a"]);
    expect(report.unknownRefs).toBe(1);
  });

  it("drops requirements that cite nothing real, empty ones and duplicates; dedupes acceptance criteria", () => {
    const { requirements, report } = resolveExtraction(
      {
        requirements: [req(), req({ chunkIds: ["c42"] }), req({ text: "  " }), req({ text: "An expired promo code shows  'This code expired on {date}' under the field. " })],
        questions: [],
      },
      refs,
    );
    expect(requirements).toHaveLength(1);
    expect(requirements[0]!.acceptanceCriteria).toEqual(["Error under the field", "Total unchanged"]);
    expect(report.droppedRequirements).toBe(3);
  });

  it("keeps questions that cite nothing (a gap can be about what's missing) but drops duplicates", () => {
    const q = { question: "Can a promo code and a gift card be used together?", why: "Not stated", chunkIds: [] };
    const { questions, report } = resolveExtraction({ requirements: [], questions: [q, { ...q, question: q.question.toUpperCase() }, { question: "", why: "", chunkIds: [] }] }, refs);
    expect(questions).toEqual([{ question: q.question, why: "Not stated", sourceChunkIds: [] }]);
    expect(report.droppedQuestions).toBe(2);
  });
});

const tc = (over = {}) => ({
  title: "Expired promo code error",
  preconditions: "SPRING10 expired yesterday",
  testData: "Code SPRING10",
  steps: [
    { action: "Enter SPRING10 and select Apply", expected: "'This code expired on …' under the field" },
    { action: "Check the order summary", expected: "Total unchanged" },
  ],
  automationCandidate: true,
  chunkIds: ["c2", "c7"],
  ...over,
});

const draft = (scenarios: unknown[]): z.infer<typeof PlanDraft> =>
  PlanDraft.parse({
    name: " Checkout v2 test plan ",
    summary: "Covers the one-page checkout.",
    scope: ["One-page checkout", " "],
    outOfScope: ["Gateway internals"],
    risks: [{ area: "Payment hand-off", risk: "high", why: "Revenue", priority: "P0" }],
    criticalRequirements: [],
    stories: [],
    scenarios: scenarios.map((x) => ({ storyRef: "S1", actor: "Guest shopper", situation: "Checks out", outcome: "Order placed", ...(x as object) })),
  });

describe("PlanDraft schema", () => {
  it("rejects unknown priorities and kinds", () => {
    expect(() => draft([{ title: "x", priority: "P9", kind: "happy", requirementKeys: [], testCases: [] }])).toThrow();
    expect(() => draft([{ title: "x", priority: "P0", kind: "sad", requirementKeys: [], testCases: [] }])).toThrow();
  });
});

describe("resolvePlan", () => {
  const known = new Set(["REQ-01", "REQ-02"]);

  it("keeps scenarios that cover known requirements and resolves case citations", () => {
    const { plan, scenarios, report } = resolvePlan(draft([{ title: "Expired code", priority: "P0", kind: "negative", requirementKeys: ["req-02", "REQ-77"], testCases: [tc()] }]), known, refs);
    expect(plan.name).toBe("Checkout v2 test plan");
    expect(plan.scope).toEqual(["One-page checkout"]);
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]!.requirementKeys).toEqual(["REQ-02"]);
    expect(scenarios[0]!.testCases[0]!.sourceChunkIds).toEqual(["chunk-b"]);
    expect(scenarios[0]!.testCases[0]!.automationCandidate).toBe(true);
    expect(report).toMatchObject({ unknownRequirements: 1, unknownRefs: 1, droppedScenarios: 0 });
  });

  it("drops scenarios with no known requirement and cases with no complete step", () => {
    const { scenarios, report } = resolvePlan(
      draft([
        { title: "Made up", priority: "P1", kind: "happy", requirementKeys: ["REQ-99"], testCases: [tc()] },
        { title: "Half-written", priority: "P1", kind: "edge", requirementKeys: ["REQ-01"], testCases: [tc({ steps: [{ action: "Do it", expected: "" }] }), tc({ title: "Good" })] },
        { title: "Empty", priority: "P2", kind: "edge", requirementKeys: ["REQ-01"], testCases: [] },
      ]),
      known,
      refs,
    );
    expect(scenarios.map((s) => s.title)).toEqual(["Half-written"]);
    expect(scenarios[0]!.testCases.map((c) => c.title)).toEqual(["Good"]);
    expect(report.droppedScenarios).toBe(2);
    expect(report.droppedTestCases).toBe(2); // the incomplete case, and the case in the made-up scenario
  });
});

describe("business scenarios and coverage", () => {
  const known = new Set(["REQ-01", "REQ-02", "REQ-03"]);

  it("keeps who, situation and outcome, and the critical requirements the plan names", () => {
    const raw = { ...draft([{ title: " Guest applies an expired code ", actor: " Guest shopper ", situation: "Applies SPRING10, expired yesterday", outcome: "Total unchanged; told the code expired", priority: "P1", kind: "negative", requirementKeys: ["REQ-02"], testCases: [tc()] }]), criticalRequirements: [{ key: "req-02", why: "Lost revenue" }, { key: "REQ-99", why: "?" }, { key: "REQ-02", why: "dup" }] };
    const { scenarios, critical } = resolvePlan(raw, known, refs);
    expect(scenarios[0]).toMatchObject({ title: "Guest applies an expired code", actor: "Guest shopper", situation: "Applies SPRING10, expired yesterday", outcome: "Total unchanged; told the code expired" });
    expect(critical).toEqual([{ key: "REQ-02", why: "Lost revenue" }]);
  });

  it("needs a positive scenario for every requirement and a negative one for every critical requirement", () => {
    const scen = [
      { kind: "happy" as const, requirementKeys: ["REQ-01", "REQ-02"] },
      { kind: "edge" as const, requirementKeys: ["REQ-02", "REQ-03"] },
    ];
    expect(coverageGaps(["REQ-01", "REQ-02", "REQ-03"], new Set(["REQ-01", "REQ-02"]), scen)).toEqual([
      { key: "REQ-01", missing: "negative" },
      { key: "REQ-02", missing: "negative" },
      { key: "REQ-03", missing: "positive" },
    ]);
    expect(coverageGaps(["REQ-01"], new Set(["REQ-01"]), [{ kind: "happy", requirementKeys: ["REQ-01"] }, { kind: "negative", requirementKeys: ["REQ-01"] }])).toEqual([]);
  });

  it("treats requirements under P0 or P1 scenarios as critical even if the plan forgot to list them", () => {
    const keys = criticalKeys([{ key: "REQ-03" }], [{ priority: "P1", requirementKeys: ["REQ-01"] }, { priority: "P2", requirementKeys: ["REQ-02"] }]);
    expect([...keys].sort()).toEqual(["REQ-01", "REQ-03"]);
  });
});

describe("user stories", () => {
  const known = new Set(["REQ-01", "REQ-02", "REQ-03"]);
  const story = (o: Record<string, unknown> = {}) => ({ ref: "S1", title: "Book a fitting", actor: "customer", want: "book a fitting at my store", soThat: "the store expects me", acceptanceCriteria: ["Store is required", " ", "Store is required"], requirementKeys: ["req-01", "REQ-02", "REQ-99"], priority: "P2", critical: false, criticalWhy: "", ...o });

  it("keeps stories that cover known requirements and say who, what and why", () => {
    const out = resolveStories([story(), story({ ref: "s1" }), story({ ref: "S2", requirementKeys: ["REQ-99"] }), story({ ref: "S3", want: " " }), story({ ref: "S4", priority: "P1" })] as never, known);
    expect(out.map((s) => s.ref)).toEqual(["S1", "S4"]); // duplicate ref, no known requirement and no "want" are dropped
    expect(out[0]).toMatchObject({ requirementKeys: ["REQ-01", "REQ-02"], acceptanceCriteria: ["Store is required"], critical: false, criticalWhy: null });
    expect(out[1]!.critical).toBe(true); // a P1 story counts as critical even if not marked
  });

  it("links scenarios to stories and unlinks those naming a story that doesn't exist", () => {
    const raw = { ...draft([{ title: "Books at Penrith", storyRef: "s1", priority: "P1", kind: "happy", requirementKeys: ["REQ-01"], testCases: [tc()] }, { title: "Orphan", storyRef: "S9", priority: "P2", kind: "edge", requirementKeys: ["REQ-01"], testCases: [tc()] }]), stories: [story()] };
    const { stories, scenarios } = resolvePlan(raw as never, known, refs);
    expect(stories.map((s) => s.ref)).toEqual(["S1"]);
    expect(scenarios.map((s) => [s.title, s.storyRef])).toEqual([["Books at Penrith", "S1"], ["Orphan", null]]);
  });

  it("needs a positive scenario per story and a negative one per critical story", () => {
    const gaps = storyGaps([{ ref: "S1", critical: true }, { ref: "S2", critical: false }, { ref: "S3", critical: true }], [{ kind: "happy", storyRef: "S1" }, { kind: "edge", storyRef: "S2" }, { kind: "happy", storyRef: "S3" }, { kind: "negative", storyRef: "S3" }]);
    expect(gaps).toEqual([{ key: "S1", missing: "negative" }, { key: "S2", missing: "positive" }]);
  });
});

