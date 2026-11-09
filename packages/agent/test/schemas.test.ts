import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { Extraction, PlanDraft, resolveExtraction, resolvePlan, type ChunkRefs } from "../src/schemas";

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
    scenarios,
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
