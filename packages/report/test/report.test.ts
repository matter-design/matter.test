import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { PNG } from "pngjs";
import { buildReport, groupFindings, perfFromCheckResults, renderReportHtml, renderReportPdf, visualChanges, type ReportCapture, type ReportFinding } from "../src/index";
import { sampleInput } from "./sample";

describe("grouping", () => {
  it("groups by rule, takes the worst severity and counts pages, instances and new ones", () => {
    const f = (url: string, severity: ReportFinding["severity"], isNew = false): ReportFinding => ({ category: "links", rule: "links.link-4xx", severity, title: `Broken link (404): https://x.test/gone${url}`, url: `https://x.test${url}`, isNew });
    const [g, ...rest] = groupFindings([f("/a", "medium"), f("/a", "medium", true), f("/b", "high"), { category: "seo", rule: "seo.og-missing", severity: "low", title: "Open Graph tags missing", url: "https://x.test/a" }]);
    expect(rest).toHaveLength(1);
    expect(g).toMatchObject({ rule: "links.link-4xx", severity: "high", count: 3, pages: 2, newCount: 1, label: "Broken links" });
    expect(g!.why).toContain("page not found");
  });

  it("uses plain wording for common axe rules and axe's own text otherwise", () => {
    const [known, unknown] = groupFindings([
      { category: "accessibility", rule: "axe.button-name", severity: "critical", title: "Buttons must have discernible text", url: "https://x.test/", wcag: "4.1.2" },
      { category: "accessibility", rule: "axe.some-new-rule", severity: "low", title: "Some new axe rule", url: "https://x.test/" },
    ]);
    expect(known!.label).toBe("Buttons without a name");
    expect(known!.fix).toContain("aria-label");
    expect(unknown!.label).toBe("Some new axe rule");
  });
});

describe("report model", () => {
  const m = buildReport(sampleInput());

  it("summarises severities and leads with the urgent work", () => {
    expect(m.bySeverity).toEqual({ critical: 4, high: 11, medium: 23, low: 44, info: 0 });
    expect(m.headline).toBe("4 critical and 11 high-priority issues across 184 pages need attention first.");
    expect(m.priorities[0]!.severity).toBe("critical");
    expect(m.priorities.every((g) => g.severity === "critical" || g.severity === "high")).toBe(true);
  });

  it("orders performance by page type and groups accessibility by WCAG criterion", () => {
    expect(m.perfByTemplate.map((p) => p.template)).toEqual(["home", "plp", "pdp", "blog"]);
    expect(m.wcag.map((w) => w.criterion)).toEqual(["1.1.1", "1.4.3", "2.4.4", "4.1.2"]);
  });

  it("gives a calm headline when nothing urgent is open", () => {
    const calm = buildReport({ ...sampleInput(), findings: [{ category: "seo", rule: "seo.og-missing", severity: "low", title: "x", url: "https://x.test/" }] });
    expect(calm.headline).toBe("No critical or high-priority issues across 184 pages. The remaining items are improvements.");
  });
});

describe("HTML", () => {
  it("escapes everything that came from the crawled site", () => {
    const input = sampleInput();
    input.findings.push({ category: "seo", rule: "seo.title-duplicate", severity: "medium", title: "x", url: "https://x.test/", selector: `<img src=x onerror=alert(1)>` });
    input.client.name = `Acme <script>alert(1)</script>`;
    const html = renderReportHtml(buildReport(input));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("only accepts hex colours and https logos from branding", () => {
    const input = sampleInput();
    input.client.branding = { primary: "red;} body{display:none", accent: "#abc", logoUrl: "javascript:alert(1)" };
    const html = renderReportHtml(buildReport(input));
    expect(html).not.toContain("display:none");
    expect(html).toContain("--accent: #abc");
    expect(html).not.toContain("javascript:");
  });

  it("explains that performance is lab data and the click is not INP", () => {
    const html = renderReportHtml(buildReport(sampleInput()));
    expect(html).toContain("Chrome UX Report");
    expect(html).toContain("is not, Google's Interaction to Next Paint");
  });
});

describe("browsers and devices", () => {
  it("draws the browser x device grid with the most important problem per cell", () => {
    const html = renderReportHtml(buildReport(sampleInput()));
    expect(html).toContain("Browsers and devices");
    expect(html).toContain('<th colspan="3" class="grp">Safari</th>');
    expect(html).toContain("Changed 8.4%");
    expect(html).toContain("Scrolls sideways");
    expect(html).toContain("JS error");
  });

  it("crops before/after images around the change, one per page, biggest first", async () => {
    const img = (fill: number) => {
      const p = new PNG({ width: 400, height: 300 });
      p.data.fill(fill);
      return PNG.sync.write(p);
    };
    const files: Record<string, Buffer> = { "b.png": img(255), "c.png": img(0) };
    const cap = (over: Partial<ReportCapture>): ReportCapture => ({ url: "https://x.test/", template: "home", browser: "chromium", viewport: "desktop", status: "changed", diffRatio: 0.1, changedBox: { x: 100, y: 50, width: 50, height: 40 }, baselineUri: "b.png", currentUri: "c.png", overflowPx: 0, jsErrors: [], brokenImages: [], ...over });
    const changes = await visualChanges(
      [cap({ browser: "webkit", viewport: "mobile" }), cap({}), cap({ url: "https://x.test/a", diffRatio: 0.4 }), cap({ url: "https://x.test/gone", currentUri: "missing.png" })],
      async (u) => files[u] ?? null,
    );
    expect(changes.map((c) => [c.url, c.browser, c.viewport])).toEqual([["https://x.test/a", "chromium", "desktop"], ["https://x.test/", "chromium", "desktop"]]);
    const crop = PNG.sync.read(Buffer.from(changes[0]!.before.split(",")[1]!, "base64"));
    expect([crop.width, crop.height]).toEqual([98, 88]); // 50x40 box + 24 px padding each side
  });
});

describe("check_results adapter", () => {
  it("rebuilds per-page performance from stored metric rows", () => {
    const url = "https://x.test/";
    const perf = perfFromCheckResults([
      { url, metric: "lcp", value: { value: 3100, rating: "needs-improvement", template: "home", engine: "lighthouse" } },
      { url, metric: "cls", value: { value: 0.12, template: "home" } },
      { url, metric: "tbt", value: { value: 250, template: "home" } },
      { url, metric: "lighthouse-score", value: { value: 64, insights: [{ id: "a", title: "Improve image delivery" }], template: "home" } },
      { url, metric: "interaction", value: { value: 180, target: "button[aria-expanded] → button Menu", template: "home" } },
      { url, metric: "weight", value: { transferBytes: 2_000_000, template: "home" } },
    ]);
    expect(perf).toEqual([
      expect.objectContaining({ url, template: "home", engine: "lighthouse", score: 64, lcp: 3100, cls: 0.12, tbt: 250, transferBytes: 2_000_000, interaction: { latency: 180, target: "button[aria-expanded] → button Menu" } }),
    ]);
  });
});

describe("PDF", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("prints a multi-page A4 PDF", async () => {
    const pdf = await renderReportPdf(browser, buildReport(sampleInput()));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages.length).toBeGreaterThanOrEqual(5);
    // A4 is 595 x 842 points.
    const [, w, h] = /\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)/.exec(pdf.toString("latin1"))!;
    expect(Math.round(Number(w))).toBe(595);
    expect(Math.round(Number(h))).toBe(842);
  }, 60_000);
});

describe("artefact folder", () => {
  it("resolves a relative ARTEFACT_DIR from the repo root, whatever the current folder", async () => {
    const { artefactDir, artefactPath } = await import("@mattertest/core");
    const before = process.env.ARTEFACT_DIR;
    process.env.ARTEFACT_DIR = "./artefacts";
    try {
      expect(artefactDir()).toMatch(/[/\\]artefacts$/);
      expect(artefactDir()).not.toContain(`${"packages"}/report/artefacts`);
      expect(() => artefactPath("../../etc/passwd")).toThrow(/escapes/);
    } finally {
      if (before === undefined) delete process.env.ARTEFACT_DIR;
      else process.env.ARTEFACT_DIR = before;
    }
  });
});
