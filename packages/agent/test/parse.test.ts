import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { parseCaptions, parseDocx, parseMarkdown, parsePdf, parseTextTranscript, parseTranscript, toSeconds } from "../src/parse";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("parseMarkdown", () => {
  it("tracks nested headings and splits paragraphs and lists", () => {
    const blocks = parseMarkdown(fixture("checkout-brief.md"));
    const expired = blocks.find((b) => b.text.startsWith("If a code has expired"));
    expect(expired?.headings).toEqual(["Northwind Outdoor: Checkout v2 brief", "5. Promo codes and gift cards", "5.2 Invalid and expired codes"]);
    const scope = blocks.find((b) => b.text.startsWith("- One-page checkout"));
    expect(scope?.headings.at(-1)).toBe("2.1 In scope");
    expect(scope?.text.split("\n")).toHaveLength(4);
    // Heading text is not repeated as body text.
    expect(blocks.some((b) => b.text.startsWith("#"))).toBe(false);
  });

  it("keeps code fences whole, ignores # inside them, and skips heading levels cleanly", () => {
    const blocks = parseMarkdown("# A\n\n### C\n\ntext\n\n```\n# not a heading\n\nstill code\n```\n");
    expect(blocks[0]).toEqual({ headings: ["A", "C"], text: "text" });
    expect(blocks[1]!.text).toContain("# not a heading\n\nstill code");
  });

  it("strips inline markup from headings", () => {
    expect(parseMarkdown("## **Bold** [link](http://x) `code`\n\nbody")[0]!.headings).toEqual(["Bold link code"]);
  });
});

describe("parseDocx", () => {
  it("reads headings, paragraphs and list items", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: "Checkout brief", heading: HeadingLevel.HEADING_1 }),
            new Paragraph({ text: "Promo codes", heading: HeadingLevel.HEADING_2 }),
            new Paragraph("Only one code per order & no stacking."),
            new Paragraph({ text: "Shipping", heading: HeadingLevel.HEADING_2 }),
            new Paragraph("Free over $99."),
          ],
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const blocks = await parseDocx(buf);
    expect(blocks).toEqual([
      { headings: ["Checkout brief", "Promo codes"], text: "Only one code per order & no stacking." },
      { headings: ["Checkout brief", "Shipping"], text: "Free over $99." },
    ]);
  });
});

describe("parsePdf", () => {
  it("reads text per page and picks up numbered headings", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = [["5.2 Invalid codes", "If a code has expired, show an error under the field."], ["6 Payment", "Afterpay is shown for orders between $35 and $2,000."]];
    for (const page of lines) {
      const p = pdf.addPage([595, 842]);
      page.forEach((text, i) => p.drawText(text, { x: 50, y: 780 - i * 40, size: 12, font }));
    }
    const { blocks, pages } = await parsePdf(await pdf.save());
    expect(pages).toBe(2);
    const expired = blocks.find((b) => b.text.includes("expired"));
    expect(expired).toMatchObject({ page: 1, headings: ["5.2 Invalid codes"] });
    const afterpay = blocks.find((b) => b.text.includes("Afterpay"));
    expect(afterpay).toMatchObject({ page: 2, headings: ["6 Payment"] });
  });
});

describe("transcripts", () => {
  it("parses WebVTT cues with times", () => {
    const cues = parseCaptions(fixture("walkthrough.vtt"));
    expect(cues).toHaveLength(5);
    expect(cues[1]).toMatchObject({ start: 7, end: 15 });
    expect(cues[3]!.text).toMatch(/^And the back-in-stock thing/);
  });

  it("parses SRT, dropping voice and style tags", () => {
    const srt = "1\n00:01:02,500 --> 00:01:05,000\n<v Sam>Hello <b>there</b> &amp; welcome\n\n2\n00:01:06,000 --> 00:01:08,000\nSecond line\n";
    expect(parseCaptions(srt)).toEqual([
      { start: 62.5, end: 65, text: "Sam: Hello there & welcome" },
      { start: 66, end: 68, text: "Second line" },
    ]);
  });

  it("parses timestamped plain-text transcripts; each line ends where the next starts", () => {
    const cues = parseTextTranscript("0:00 Hi team\n0:07 - The size guide opens in a drawer\n[1:02] Reviews under the name\n");
    expect(cues.map((c) => [c.start, c.end])).toEqual([[0, 7], [7, 62], [62, 67]]);
    expect(cues[1]!.text).toBe("The size guide opens in a drawer");
  });

  it("treats untimed text as paragraphs", () => {
    const cues = parseTranscript("First para\nline two\n\nSecond para");
    expect(cues.map((c) => c.text)).toEqual(["First para line two", "Second para"]);
    expect(Number.isNaN(cues[0]!.start)).toBe(true);
  });

  it("converts timestamps", () => {
    expect(toSeconds("01:02:03.5")).toBe(3723.5);
    expect(toSeconds("2:03,25")).toBe(123.25);
  });
});
