import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemBlocks } from "../src/claude";
import { GUIDELINES_MAX, cleanGuidelines, guidelinesPath, loadGuidelines } from "../src/guidelines";
import { EXTRACT_SYSTEM, PLAN_SYSTEM } from "../src/prompts";

const dir = mkdtempSync(join(tmpdir(), "mt-guide-"));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe("QA guidelines file", () => {
  it("drops editing comments and extra blank lines", () => {
    expect(cleanGuidelines("<!-- notes for editors\nmore -->\n\n# Rules\n\n\n\n- P0: money\r\n")).toBe("# Rules\n\n- P0: money");
  });

  it("loads the guide with a version that changes when the text does", async () => {
    const a = await loadGuidelines(write("a.md", "<!-- x -->\n# Rules\n- One"));
    const b = await loadGuidelines(write("b.md", "# Rules\n- One\n"));
    const c = await loadGuidelines(write("c.md", "# Rules\n- Two"));
    expect(a).toMatchObject({ text: "# Rules\n- One" });
    expect(a!.version).toMatch(/^[0-9a-f]{12}$/);
    expect(b!.version).toBe(a!.version); // comments and whitespace don't count as a change
    expect(c!.version).not.toBe(a!.version);
  });

  it("is null when the file is missing or only comments", async () => {
    expect(await loadGuidelines(join(dir, "missing.md"))).toBeNull();
    expect(await loadGuidelines(write("empty.md", "<!-- just notes -->\n\n"))).toBeNull();
  });

  it("cuts a guide that's far too long", async () => {
    const g = await loadGuidelines(write("long.md", "x".repeat(GUIDELINES_MAX + 500)));
    expect(g!.text.length).toBeLessThan(GUIDELINES_MAX + 200);
    expect(g!.text).toContain("The rest of the guide was cut");
  });

  it("lives at docs/qa-guidelines.md unless QA_GUIDELINES_PATH says otherwise", () => {
    expect(guidelinesPath({})).toMatch(/docs\/qa-guidelines\.md$/);
    expect(guidelinesPath({ QA_GUIDELINES_PATH: "/tmp/qa.md" })).toBe("/tmp/qa.md");
  });

  it("the repo's guide loads and has content", async () => {
    const g = await loadGuidelines();
    expect(g?.text).toContain("# Matter Design QA guidelines");
    expect(g?.text).not.toContain("<!--");
    expect(readFileSync(guidelinesPath(), "utf8")).toContain("<!--");
  });
});

describe("system blocks", () => {
  it("adds the guide as a second cached block after the fixed instructions", () => {
    const blocks = systemBlocks("Fixed.", "  - P0: money  ");
    expect(blocks).toEqual([
      { type: "text", text: "Fixed." },
      { type: "text", text: "<qa_guidelines>\n- P0: money\n</qa_guidelines>", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("caches the fixed instructions alone when there's no guide", () => {
    expect(systemBlocks("Fixed.", null)).toEqual([{ type: "text", text: "Fixed.", cache_control: { type: "ephemeral" } }]);
  });

  it("both prompts say how the guide ranks against project instructions", () => {
    for (const p of [EXTRACT_SYSTEM, PLAN_SYSTEM]) expect(p).toMatch(/<qa_guidelines>[\s\S]*override the guidelines where they conflict/);
  });
});
