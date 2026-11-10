import { describe, expect, it } from "vitest";
import { EXTRACT_SYSTEM, PLAN_SYSTEM, extractUser, planUser, type Passage } from "../src/prompts";

const ctx = { project: "Checkout v2", client: "Northwind", platform: "bigcommerce" };
const passages: Passage[] = [{ ref: "c1", sourceName: "brief.md", sourceType: "md", sectionPath: "Shipping", locator: {}, text: "Free over $99." }];

describe("team instructions in prompts", () => {
  it("puts the project's instructions and the source note in the extraction message, escaped", () => {
    const user = extractUser({ ...ctx, sourceName: "brief.md", sourceType: "md", passages, instructions: "  Focus on <checkout> & skip marketing.  ", sourceNote: "Only section 4 applies." });
    expect(user).toContain("<team_instructions>\nFocus on &lt;checkout&gt; &amp; skip marketing.\n</team_instructions>");
    expect(user).toContain("<source_note>\nOnly section 4 applies.\n</source_note>");
    // Instructions come before the source, so the passages stay one block.
    expect(user.indexOf("<team_instructions>")).toBeLessThan(user.indexOf("<source>"));
  });

  it("leaves both out when they're empty", () => {
    const user = extractUser({ ...ctx, sourceName: "brief.md", sourceType: "md", passages, instructions: "   ", sourceNote: null });
    expect(user).not.toContain("team_instructions");
    expect(user).not.toContain("source_note");
  });

  it("names Confluence pages as such", () => {
    expect(extractUser({ ...ctx, sourceName: "Spec", sourceType: "confluence", passages })).toContain('a Confluence page');
  });

  it("gives the planner the instructions and the notes on each source", () => {
    const user = planUser({ ...ctx, requirements: [], passages, openQuestions: [], instructions: "Payments are P0.", sourceNotes: [{ source: "brief.md", note: "Draft from May" }, { source: "x", note: " " }] });
    expect(user).toContain("<team_instructions>\nPayments are P0.\n</team_instructions>");
    expect(user).toContain("- brief.md: Draft from May");
    expect(user).not.toContain("- x:");
  });

  it("tells the model instructions can't stand in for the sources", () => {
    expect(EXTRACT_SYSTEM).toMatch(/team_instructions[\s\S]*never replace the sources/);
    expect(PLAN_SYSTEM).toMatch(/team_instructions[\s\S]*never replace the sources/);
  });
});
