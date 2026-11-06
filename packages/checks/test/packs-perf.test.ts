import { describe, expect, it } from "vitest";
import { bigcommercePack, bigcommerceTemplate, perfFindings, rate, toMetrics, type PackPage, type PerfMetrics } from "../src/index";

const ctx = { baseUrl: "https://shop.test/", robotsTxt: "User-agent: *\nDisallow: /cart.php\nDisallow: /checkout\nSitemap: https://shop.test/xmlsitemap.php\n" };
const stencil = (type: string, body: string, head = "") =>
  `<html><head>${head}</head><body>${body}<script>window.stencilBootstrap("${type}", "{}", true).load();</script></body></html>`;
const page = (url: string, html: string, template = bigcommerceTemplate(html) ?? "unknown"): PackPage => ({ url, status: 200, headers: {}, html, template });
const rules = (p: PackPage) => bigcommercePack.pageFindings(p, ctx).map((f) => f.rule);

describe("BigCommerce templates", () => {
  it("reads the Stencil page type", () => {
    expect(bigcommerceTemplate(stencil("product", ""))).toBe("pdp");
    expect(bigcommerceTemplate(stencil("category", ""))).toBe("plp");
    expect(bigcommerceTemplate(stencil("default", ""))).toBe("home");
    expect(bigcommerceTemplate(stencil("account_orders", ""))).toBe("account");
    expect(bigcommerceTemplate("<html></html>")).toBeUndefined();
  });
});

describe("BigCommerce pack", () => {
  const goodPdp = stencil(
    "product",
    `<h1 class="productView-title">Trail Tent</h1><span data-product-price-without-tax>$249.00</span><form data-cart-item-add><button>Add to Cart</button></form>`,
    `<link rel="canonical" href="https://shop.test/trail-tent/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Trail Tent"}</script>`,
  );

  it("passes a healthy product page", () => {
    expect(rules(page("https://shop.test/trail-tent/", goodPdp))).toEqual([]);
  });

  it("flags sample products, zero price, missing cart form and schema", () => {
    const html = stencil("product", `<h1 class="productView-title">[Sample] Orbit Terrarium</h1><span data-product-price-without-tax>$0.00</span>`);
    expect(rules(page("https://shop.test/orbit/", html))).toEqual(["bc.sample-products", "bc.pdp-no-add-to-cart", "bc.pdp-zero-price", "bc.pdp-schema-missing"]);
  });

  it("does not ask for a cart form when the product is out of stock", () => {
    const html = stencil("product", `<h1>Tent</h1><p>Out of stock</p><span data-product-price-without-tax>$99.00</span>`, `<script type="application/ld+json">{"@graph":[{"@type":"Product"}]}</script>`);
    expect(rules(page("https://shop.test/tent/", html))).toEqual([]);
  });

  it("flags canonicals and links to the store domain", () => {
    const html = stencil("category", `<a href="https://store-abc123.mybigcommerce.com/tents/">Tents</a>`, `<link rel="canonical" href="https://store-abc123.mybigcommerce.com/tents/">`);
    expect(rules(page("https://shop.test/tents/", html))).toEqual(["bc.store-domain-canonical", "bc.store-domain-links"]);
  });

  it("ignores the store domain when the site is the store domain", () => {
    const html = stencil("category", "", `<link rel="canonical" href="https://store-abc123.mybigcommerce.com/tents/">`);
    const f = bigcommercePack.pageFindings(page("https://store-abc123.mybigcommerce.com/tents/", html), { ...ctx, baseUrl: "https://store-abc123.mybigcommerce.com/" });
    expect(f).toEqual([]);
  });

  it("flags maintenance mode on the home page as critical", () => {
    const f = bigcommercePack.pageFindings(page("https://shop.test/", stencil("default", "<p>This store is down for maintenance.</p>")), ctx);
    expect(f.map((x) => [x.rule, x.severity])).toEqual([["bc.maintenance-mode", "critical"]]);
  });

  it("flags indexable facet URLs unless canonicalised or noindexed", () => {
    const url = "https://shop.test/tents/?_bc_fsnf=1&brand[]=12";
    expect(rules(page(url, stencil("category", "")))).toEqual(["bc.facet-url-indexable"]);
    expect(rules(page(url, stencil("category", "", `<link rel="canonical" href="https://shop.test/tents/">`)))).toEqual([]);
    expect(rules(page(url, stencil("category", "", `<meta name="robots" content="noindex,follow">`)))).toEqual([]);
  });

  it("checks robots.txt and transactional pages at site level", () => {
    const cart = page("https://shop.test/cart.php", stencil("cart", ""));
    expect(bigcommercePack.siteFindings([cart], ctx).map((f) => f.rule)).toEqual(["bc.transactional-indexable"]);
    expect(bigcommercePack.siteFindings([], { ...ctx, robotsTxt: "User-agent: *\n" }).map((f) => f.rule)).toEqual(["bc.robots-no-sitemap", "bc.robots-transactional-allowed"]);
    expect(bigcommercePack.siteFindings([], { ...ctx, robotsTxt: null }).map((f) => f.rule)).toEqual(["bc.robots-missing"]);
  });
});

describe("performance thresholds", () => {
  it("rates against Core Web Vitals thresholds", () => {
    expect(rate("lcp", 2500)).toBe("good");
    expect(rate("lcp", 2501)).toBe("needs-improvement");
    expect(rate("lcp", 4001)).toBe("poor");
    expect(rate("cls", 0.1)).toBe("good");
    expect(rate("cls", 0.3)).toBe("poor");
    expect(rate("tbt", 300)).toBe("needs-improvement");
  });

  const base: PerfMetrics = { url: "https://shop.test/", engine: "browser", score: null, insights: [], interaction: null, ttfb: 200, fcp: 1000, lcp: 1500, lcpElement: null, cls: 0, tbt: 50, load: 1800, requests: 30, transferBytes: 500_000, jsBytes: 200_000, imageBytes: 100_000, renderBlocking: [], heavyImages: [] };

  it("produces no findings for a fast page", () => {
    expect(perfFindings(base)).toEqual([]);
  });

  it("flags poor vitals, weight and heavy images", () => {
    const f = perfFindings({ ...base, lcp: 5200, lcpElement: "img.hero", cls: 0.18, tbt: 700, ttfb: 2000, transferBytes: 4_500_000, jsBytes: 1_400_000, heavyImages: [{ url: "https://shop.test/hero.jpg", bytes: 900_000 }] });
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["perf.lcp-poor", "high"],
      ["perf.cls-needs-improvement", "medium"],
      ["perf.tbt-poor", "high"],
      ["perf.ttfb-poor", "medium"],
      ["perf.page-weight", "medium"],
      ["perf.js-weight", "medium"],
      ["perf.heavy-image", "low"],
    ]);
    expect(f[0]!.detail).toContain("img.hero");
    const withObserved = perfFindings({ ...base, engine: "lighthouse", lcp: 29_000, observedLcp: 2_000, requests: 552, transferBytes: 6_000_000 });
    expect(withObserved[0]!.detail).toContain("Observed without throttling: 2.00 s");
    expect(withObserved[0]!.detail).toContain("552 requests and 6.0 MB");
    expect(f[0]!.evidence).toMatchObject({ lab: true });
  });

  it("flags a low Lighthouse score with its top insights, and a slow lab interaction", () => {
    const f = perfFindings({ ...base, engine: "lighthouse", score: 41, insights: [{ id: "render-blocking-insight", title: "Render blocking requests", displayValue: "Est savings of 900 ms" }], interaction: { target: "button[aria-expanded] → button Menu", latency: 320 } });
    expect(f.map((x) => [x.rule, x.severity])).toEqual([["perf.lighthouse-score-poor", "high"], ["perf.interaction-needs-improvement", "low"]]);
    expect(f[0]!.detail).toContain("Render blocking requests (Est savings of 900 ms)");
    expect(f[1]!.selector).toBe("button[aria-expanded]");
    expect(f[1]!.detail).toContain("not real-user INP");
  });
});

describe("Lighthouse result mapping", () => {
  it("maps audits onto PerfMetrics", () => {
    const m = toMetrics("https://shop.test/", {
      categories: { performance: { score: 0.734 } },
      audits: {
        "largest-contentful-paint": { title: "LCP", score: 0.4, numericValue: 3820.4 },
        "cumulative-layout-shift": { title: "CLS", score: 1, numericValue: 0.04321 },
        "total-blocking-time": { title: "TBT", score: 0.6, numericValue: 310 },
        "first-contentful-paint": { title: "FCP", score: 0.9, numericValue: 1500 },
        "server-response-time": { title: "TTFB", score: 1, numericValue: 220 },
        "total-byte-weight": { title: "Weight", score: 1, numericValue: 1_800_000 },
        "resource-summary": { title: "Resources", score: null, details: { items: [{ resourceType: "script", transferSize: 600_000 }, { resourceType: "image", transferSize: 900_000 }] } },
        "network-requests": { title: "Requests", score: null, details: { items: [{ url: "https://shop.test/", resourceType: "Document", transferSize: 30_000 }, { url: "https://shop.test/hero.jpg", resourceType: "Image", transferSize: 700_000 }] } },
        metrics: { title: "Metrics", score: null, details: { items: [{ observedLargestContentfulPaint: 1987.4 }] } },
        "lcp-breakdown-insight": { title: "LCP breakdown", score: 0, details: { type: "list", items: [{ type: "node", selector: "div.hero > img", snippet: "<img>" }] } },
        "render-blocking-insight": { title: "Render blocking requests", score: 0, displayValue: "Est savings of 600 ms", details: { items: [{ url: "https://shop.test/theme.css" }] } },
      },
    });
    expect(m).toMatchObject({ engine: "lighthouse", score: 73, lcp: 3820, observedLcp: 1987, cls: 0.043, tbt: 310, ttfb: 220, transferBytes: 1_800_000, jsBytes: 600_000, imageBytes: 900_000, requests: 2, lcpElement: "div.hero > img", renderBlocking: ["https://shop.test/theme.css"] });
    expect(m.heavyImages).toEqual([{ url: "https://shop.test/hero.jpg", bytes: 700_000 }]);
    expect(m.insights.map((i) => i.id)).toEqual(["lcp-breakdown-insight", "render-blocking-insight"]);
  });
});
