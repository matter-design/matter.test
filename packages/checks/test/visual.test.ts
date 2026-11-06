import { mkdtemp, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { artefactPath } from "@mattertest/core";
import { diffImages, fileBaselineStore, runVisualChecks, visualFindings, type VisualCapture } from "../src/index";

const solid = (w: number, h: number, paint: (x: number, y: number) => [number, number, number]) => {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      p.data.set([r, g, b, 255], (y * w + x) * 4);
    }
  return PNG.sync.write(p);
};

describe("diffImages", () => {
  it("reports the share of changed pixels and where they are", () => {
    const a = solid(100, 100, () => [255, 255, 255]);
    const b = solid(100, 100, (x, y) => (x >= 10 && x < 30 && y >= 50 && y < 60 ? [0, 0, 0] : [255, 255, 255]));
    const d = diffImages(a, b);
    expect(d.changed).toBe(200);
    expect(d.ratio).toBeCloseTo(0.02);
    expect(d.box).toEqual({ x: 10, y: 50, width: 20, height: 10 });
  });
  it("compares the shared area when heights differ", () => {
    const d = diffImages(solid(50, 100, () => [255, 255, 255]), solid(50, 160, () => [255, 255, 255]));
    expect(d).toMatchObject({ changed: 0, heightBefore: 100, heightAfter: 160 });
  });
});

describe("visualFindings", () => {
  const cap = (over: Partial<VisualCapture>): VisualCapture => ({ url: "https://x.test/", template: "home", browser: "chromium", viewport: "desktop", status: "match", overflowPx: 0, jsErrors: [], brokenImages: [], ...over });
  it("merges cross-browser problems and flags browser-specific ones", () => {
    const f = visualFindings(
      [
        cap({ browser: "chromium", brokenImages: [] }),
        cap({ browser: "firefox", jsErrors: ["TypeError: x is undefined"] }),
        cap({ browser: "webkit", brokenImages: ["https://x.test/hero.avif"] }),
        cap({ browser: "chromium", viewport: "mobile", overflowPx: 40, overflowElement: "div.promo" }),
        cap({ browser: "webkit", viewport: "mobile", overflowPx: 38 }),
        cap({ url: "https://x.test/old", viewport: "mobile", hasViewportMeta: false }),
        cap({ url: "https://x.test/old", viewport: "desktop", hasViewportMeta: false }),
      ],
      ["chromium", "firefox", "webkit"],
    );
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["visual.horizontal-overflow", "medium"],
      ["visual.js-error-browser-specific", "high"],
      ["visual.image-browser-specific", "high"],
      ["visual.no-viewport-meta", "high"],
    ]);
    expect(f[0]!.detail).toBe("In Chrome, Safari. Widest element: div.promo.");
    expect(f[1]!.title).toBe("JavaScript error only in Firefox");
    expect(f[2]!.evidence).toMatchObject({ brokenIn: ["webkit"], workingIn: ["chromium", "firefox"] });
  });
});

/** A page whose look we can change between runs, with a mobile overflow and a Firefox-only error. */
let variant = "a";
let server: Server;
let base: string;
let browser: Browser;

const page = () => `<html lang="en"><head><title>Visual</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px sans-serif} .hero{height:300px;background:${variant === "a" ? "#1f6feb" : "#d1242f"}} .wide{width:600px;height:20px;background:#eee}
  @media (min-width: 700px) { .wide { width: 100% } }</style></head>
  <body><div class="hero"></div><h1>Store</h1><div class="wide"></div>
  <script>if (navigator.userAgent.includes("Firefox")) { setTimeout(() => { throw new Error("only in firefox") }) }</script></body></html>`;

beforeAll(async () => {
  process.env.ARTEFACT_DIR = await mkdtemp(join(tmpdir(), "mt-visual-"));
  server = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end(page()));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
  delete process.env.ARTEFACT_DIR;
});

describe("runVisualChecks in Chromium, Firefox and WebKit", () => {
  it("creates baselines, then catches a visual change and cross-browser problems", async () => {
    const pages = [{ url: base, template: "home" }];
    const opts = { chromium: browser, viewports: ["mobile", "desktop"] as const };

    variant = "a";
    const first = await runVisualChecks(pages, { ...opts, viewports: [...opts.viewports], store: fileBaselineStore("fixture", "run1") });
    expect(first.skippedBrowsers).toEqual([]);
    expect(first.captures).toHaveLength(6);
    expect(first.captures.map((c) => c.status)).toEqual(Array(6).fill("baseline-created"));

    variant = "b"; // hero turns red
    const second = await runVisualChecks(pages, { ...opts, viewports: [...opts.viewports], store: fileBaselineStore("fixture", "run2") });
    expect(second.captures.map((c) => c.status)).toEqual(Array(6).fill("changed"));
    const c = second.captures.find((x) => x.browser === "webkit" && x.viewport === "desktop")!;
    expect(c.diffRatio).toBeGreaterThan(0.05);
    expect(c.changedBox).toMatchObject({ x: 0, y: 0, height: 300 });
    expect(PNG.sync.read(await readFile(artefactPath(c.diffUri!))).width).toBe(1440);

    const f = visualFindings(second.captures, ["chromium", "firefox", "webkit"]);
    const rules = f.map((x) => x.rule);
    expect(rules.filter((r) => r === "visual.changed")).toHaveLength(6);
    // .wide is 600px on a 390px phone: sideways scroll on mobile only, in every browser.
    const overflow = f.find((x) => x.rule === "visual.horizontal-overflow")!;
    expect(overflow).toMatchObject({ selector: "mobile", detail: "In every browser. Widest element: div.wide." });
    expect(rules).not.toContain("visual.no-viewport-meta");
    expect(f.find((x) => x.rule === "visual.js-error-browser-specific")).toMatchObject({ title: "JavaScript error only in Firefox", detail: "only in firefox" });

    variant = "b"; // unchanged since run 2, but run 2 did not accept anything: still compares with run 1's baseline
    const accepted = await runVisualChecks(pages, { ...opts, viewports: ["desktop"], browsers: ["chromium"], store: fileBaselineStore("fixture", "run3", { updateBaselines: true }) });
    expect(accepted.captures[0]!.status).toBe("baseline-created");
    const after = await runVisualChecks(pages, { ...opts, viewports: ["desktop"], browsers: ["chromium"], store: fileBaselineStore("fixture", "run4") });
    expect(after.captures[0]!.status).toBe("match");
  }, 240_000);
});
