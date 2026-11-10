import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chunkBlocks, chunkCues, clock, splitLong } from "../src/chunk";
import { parseCaptions, parseMarkdown, type Cue } from "../src/parse";

const brief = readFileSync(new URL("./fixtures/checkout-brief.md", import.meta.url), "utf8");

describe("chunkBlocks", () => {
  it("never mixes sections, labels each chunk with its heading path and numbers them in order", () => {
    const chunks = chunkBlocks(parseMarkdown(brief));
    expect(chunks.map((c) => c.position)).toEqual(chunks.map((_, i) => i));
    const expired = chunks.find((c) => c.text.includes("This code expired"));
    expect(expired?.sectionPath).toBe("5. Promo codes and gift cards › 5.2 Invalid and expired codes");
    expect(expired?.text).not.toContain("stackable");
  });

  it("drops a title heading shared by every section, but keeps a lone heading", () => {
    const withTitle = chunkBlocks([{ headings: ["Brief", "1. Scope"], text: "a" }, { headings: ["Brief", "2. Shipping"], text: "b" }]);
    expect(withTitle.map((c) => c.sectionPath)).toEqual(["1. Scope", "2. Shipping"]);
    expect(chunkBlocks([{ headings: ["Only"], text: "a" }])[0]!.sectionPath).toBe("Only");
    expect(chunkBlocks([{ headings: ["A", "x"], text: "a" }, { headings: ["B"], text: "b" }]).map((c) => c.sectionPath)).toEqual(["A › x", "B"]);
  });

  it("packs small blocks of one section together up to the limit", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ headings: ["S"], text: `Para ${i} `.repeat(10).trim() }));
    const chunks = chunkBlocks(blocks, { maxChars: 300 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThan(10);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(300);
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(blocks.map((b) => b.text).join("\n\n"));
  });

  it("splits an over-long paragraph at sentence ends with overlap", () => {
    const sentence = (i: number) => `Sentence number ${i} says something about checkout rules.`;
    const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkBlocks([{ headings: [], text, page: 3 }], { maxChars: 500, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(c.sectionPath).toBe("Page 3");
      expect(c.locator).toEqual({ page: 3 });
    }
    // Neighbouring chunks overlap: the next one starts with words from the end of the previous one.
    const opening = chunks[1]!.text.split(" ").slice(0, 3).join(" ");
    expect(chunks[0]!.text.slice(-120)).toContain(opening);
  });

  it("splitLong returns short text untouched and terminates on text without spaces", () => {
    expect(splitLong("short", 100, 10)).toEqual(["short"]);
    const parts = splitLong("x".repeat(1000), 300, 50);
    expect(parts.every((p) => p.length <= 300)).toBe(true);
    expect(parts.join("").length).toBeGreaterThanOrEqual(1000);
  });
});

describe("chunkCues", () => {
  it("windows a transcript by time and labels the range", () => {
    const cues = parseCaptions(readFileSync(new URL("./fixtures/walkthrough.vtt", import.meta.url), "utf8"));
    const chunks = chunkCues(cues, { windowSec: 30, minSec: 20, pauseSec: 3 });
    expect(chunks[0]!.sectionPath).toBe("00:00–00:24");
    expect(chunks[0]!.locator).toEqual({ startSec: 0, endSec: 24 });
    // The 6-second pause after 24 s ends the first chunk (past minSec).
    expect(chunks[1]!.text).toMatch(/^And the back-in-stock thing/);
  });

  it("caps windows at windowSec even without pauses", () => {
    const cues: Cue[] = Array.from({ length: 100 }, (_, i) => ({ start: i * 5, end: i * 5 + 5, text: `line ${i}` }));
    const chunks = chunkCues(cues, { windowSec: 120 });
    expect(chunks).toHaveLength(Math.ceil(500 / 120));
    for (const c of chunks) expect(c.locator.endSec! - c.locator.startSec!).toBeLessThanOrEqual(125);
  });

  it("packs untimed transcripts as numbered parts", () => {
    const chunks = chunkCues([{ start: NaN, end: NaN, text: "a".repeat(900) }, { start: NaN, end: NaN, text: "b".repeat(900) }]);
    expect(chunks.map((c) => c.sectionPath)).toEqual(["Part 1", "Part 2"]);
    expect(chunks[0]!.locator).toEqual({});
  });

  it("formats clock times", () => {
    expect(clock(125)).toBe("02:05");
    expect(clock(3725)).toBe("1:02:05");
  });
});
