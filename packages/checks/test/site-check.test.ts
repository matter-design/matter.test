import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { runSiteCheck } from "../src/index";

/** A tiny fake storefront with known problems, so the full pipeline can be checked offline. */
const PAGES: Record<string, { status?: number; headers?: Record<string, string>; body: string }> = {
  "/": {
    body: `<html lang="en"><head><title>Home | Fixture</title><meta name="description" content="Fixture home">
      <link rel="canonical" href="/"><meta property="og:title" content="Home">
      <script src="https://cdn11.bigcommerce.com/s-test/app.js" async></script><script>var jsContext = {};</script></head>
      <body><h1>Fixture store</h1>
      <a href="/products/tent">Tent</a> <a href="/category/tents/">Tents</a> <a href="/missing">Broken</a> <a href="/orbit-terrarium/">Orbit</a> <a href="/old">Old</a>
      <img src="/img/missing.png" alt="missing image">
      <button><svg width="10" height="10"></svg></button>
      <form method="post" action="/cart.php"><button type="submit">Add to cart</button></form>
      <button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');fetch('/api/track',{method:'POST'});var t=Date.now();while(Date.now()-t<300){}">Menu</button></body></html>`,
  },
  "/products/tent": {
    body: `<html lang="en"><head><title>Tent | Fixture</title></head><body><h1>Tent</h1><h1>Again</h1><a href="/">Home</a></body></html>`,
  },
  "/category/tents/": {
    body: `<html lang="en"><head><title>Tent | Fixture</title><meta name="robots" content="noindex"></head><body><h1>Tents</h1></body></html>`,
  },
  "/orbit-terrarium/": {
    body: `<html lang="en"><head><title>[Sample] Orbit Terrarium | Fixture</title><link rel="canonical" href="https://store-abc123.mybigcommerce.com/orbit-terrarium/"></head>
      <body><h1 class="productView-title">[Sample] Orbit Terrarium</h1><span data-product-price-without-tax>$0.00</span>
      <script>window.stencilBootstrap("product", "{}", true);</script></body></html>`,
  },
  "/old": { status: 301, headers: { location: "/older" }, body: "" },
  "/older": { status: 301, headers: { location: "/oldest" }, body: "" },
  "/oldest": { status: 301, headers: { location: "/products/tent" }, body: "" },
  "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /cart\n" },
};

let server: Server;
const nonGetRequests: string[] = [];
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (req.method !== "GET" && req.method !== "HEAD") nonGetRequests.push(`${req.method} ${path}`);
    const page = PAGES[path];
    if (!page) {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    res.writeHead(page.status ?? 200, { "content-type": "text/html", ...page.headers }).end(req.method === "HEAD" ? undefined : page.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

describe("runSiteCheck against the fixture site", () => {
  it("crawls, detects the platform and reports the planted problems", async () => {
    const result = await runSiteCheck(browser, {
      baseUrl: `${base}/`,
      categories: ["crawl", "links", "seo", "security", "accessibility", "performance", "platform"],
      perfThrottle: "none",
      maxPages: 20,
      concurrency: 2,
      delayMs: 0,
    });
    const rules = new Set(result.findings.map((f) => f.rule));

    expect(result.platform).toBe("bigcommerce");
    expect(result.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/category/tents/", "/missing", "/old", "/orbit-terrarium/", "/products/tent"].sort());
    // /orbit-terrarium/ has a flat BigCommerce URL; the pack reads its Stencil page type.
    expect(result.templates).toMatchObject({ home: 1, pdp: 2, plp: 1 });

    expect(rules).toContain("crawl.status-404"); // /missing was crawled
    expect(rules).toContain("links.image-4xx"); // /img/missing.png
    expect(rules).toContain("seo.noindex");
    expect(rules).toContain("seo.h1-multiple");
    expect(rules).toContain("seo.title-duplicate");
    expect(rules).toContain("security.not-https");
    expect(rules).toContain("security.csp-missing");
    expect(rules).toContain("axe.button-name"); // icon-only button on home

    // BigCommerce pack
    expect(rules).toContain("bc.sample-products");
    expect(rules).toContain("bc.pdp-zero-price");
    expect(rules).toContain("bc.pdp-no-add-to-cart");
    expect(rules).toContain("bc.store-domain-canonical");
    expect(rules).toContain("bc.robots-no-sitemap");

    // Performance: one lab measurement per template, with real numbers from the browser.
    const home = result.perf.find((m) => m.template === "home")!;
    expect(home).toBeDefined();
    expect(home.ttfb).toBeGreaterThanOrEqual(0);
    expect(home.fcp).toBeGreaterThan(0);
    expect(home.lcp).toBeGreaterThan(0);
    expect(home.engine).toBe("lighthouse");
    expect(home.score).toBeGreaterThan(0);

    // The scripted click hit the menu toggle (busy-loops ~300 ms), not the add-to-cart form,
    // and the menu's POST beacon was blocked before it left the browser.
    expect(home.interaction?.target).toContain("Menu");
    expect(home.interaction!.latency).toBeGreaterThanOrEqual(250);
    expect(rules).toContain("perf.interaction-needs-improvement");
    expect(nonGetRequests).toEqual([]);
    expect(result.perf.map((m) => m.template)).toEqual(expect.arrayContaining(["home", "pdp", "plp"]));

    const btn = result.findings.find((f) => f.rule === "axe.button-name")!;
    expect(btn.wcag).toBe("4.1.2");
    expect(btn.severity).toBe("critical");
  }, 300_000);

  it("falls back to in-browser measurement when Lighthouse is off", async () => {
    const result = await runSiteCheck(browser, { baseUrl: `${base}/`, categories: ["performance"], maxPages: 1, delayMs: 0, perfEngine: "browser", perfThrottle: "none", perfInteraction: false });
    expect(result.perf).toHaveLength(1);
    expect(result.perf[0]).toMatchObject({ engine: "browser", score: null, interaction: null, template: "home" });
    expect(result.perf[0]!.fcp).toBeGreaterThan(0);
  }, 60_000);
});
