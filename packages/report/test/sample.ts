import type { ReportFinding, ReportInput } from "../src/index";

/** A realistic BigCommerce store result, used by the tests and to eyeball the PDF. */
export function sampleInput(): ReportInput {
  const base = "https://www.northwind-outdoor.com.au";
  const f: ReportFinding[] = [];
  const add = (x: Omit<ReportFinding, "url"> & { url: string }) => f.push({ ...x, url: base + x.url });
  for (const p of ["/trail-tent/", "/orbit-terrarium/", "/camp-stove/"]) add({ category: "platform", rule: "bc.sample-products", severity: "high", title: 'Sample catalogue visible (1 "[Sample]" item)', url: p, isNew: p === "/camp-stove/" });
  add({ category: "platform", rule: "bc.store-domain-canonical", severity: "high", title: "Canonical points at the store domain store-abc123.mybigcommerce.com", url: "/tents/", selector: 'link[rel="canonical"]' });
  add({ category: "platform", rule: "bc.pdp-zero-price", severity: "high", title: "Product shows a zero price ($0.00)", url: "/orbit-terrarium/" });
  add({ category: "platform", rule: "bc.robots-no-sitemap", severity: "low", title: "robots.txt does not list a sitemap", url: "/robots.txt" });
  add({ category: "security", rule: "security.exposed-file", severity: "critical", title: "Publicly readable: /.env", url: "/.env", selector: "/.env" });
  add({ category: "security", rule: "security.csp-missing", severity: "medium", title: "Content-Security-Policy header missing", url: "/" });
  add({ category: "security", rule: "security.hsts-missing", severity: "medium", title: "Strict-Transport-Security header missing", url: "/" });
  for (let i = 0; i < 14; i++) add({ category: "links", rule: "links.link-4xx", severity: "medium", title: `Broken link (404): ${base}/old-range-${i}/`, url: `/blog/post-${i % 5}/`, selector: `${base}/old-range-${i}/` });
  add({ category: "links", rule: "links.redirect-chain", severity: "low", title: "Redirect chain of 3 hops", url: "/", selector: `${base}/old` });
  for (let i = 0; i < 40; i++) add({ category: "seo", rule: "seo.og-missing", severity: "low", title: "Open Graph tags missing", url: `/product-${i}/` });
  add({ category: "seo", rule: "seo.noindex", severity: "high", title: "Page is set to noindex", url: "/tents/", detail: "meta robots: noindex" });
  for (const u of ["/tents/", "/tents/?sort=price"]) add({ category: "seo", rule: "seo.title-duplicate", severity: "medium", title: "Title shared by 2 pages", url: u, detail: "Tents | Northwind" });
  add({ category: "accessibility", rule: "axe.button-name", severity: "critical", title: "Buttons must have discernible text", url: "/", wcag: "4.1.2", selector: "button.navUser-action--search", detail: "Fix any of the following:\n  Element does not have inner text that is visible to screen readers" });
  add({ category: "accessibility", rule: "axe.button-name", severity: "critical", title: "Buttons must have discernible text", url: "/tents/", wcag: "4.1.2", selector: "button.mobileMenu-toggle" });
  add({ category: "accessibility", rule: "axe.color-contrast", severity: "high", title: "Elements must meet minimum color contrast ratio thresholds", url: "/", wcag: "1.4.3", selector: ".footer-info-heading" });
  add({ category: "accessibility", rule: "axe.image-alt", severity: "critical", title: "Images must have alternative text", url: "/trail-tent/", wcag: "1.1.1", selector: "img.productView-image--default" });
  add({ category: "accessibility", rule: "axe.link-name", severity: "high", title: "Links must have discernible text", url: "/", wcag: "2.4.4", selector: "a.footer-social-link" });
  add({ category: "visual", rule: "visual.js-error-browser-specific", severity: "high", title: "JavaScript error only in Safari", url: "/trail-tent/", selector: "TypeError: undefined is not an object", detail: "TypeError: undefined is not an object (evaluating 'a.swatch')" });
  add({ category: "visual", rule: "visual.horizontal-overflow", severity: "medium", title: "Page scrolls sideways on mobile (42 px too wide)", url: "/tents/", selector: "mobile" });
  for (const b of ["chromium", "firefox", "webkit"]) add({ category: "visual", rule: "visual.changed", severity: "medium", title: `Page looks different from the approved version (8.4% changed, ${b} desktop)`, url: "/", selector: `${b}/desktop` });
  add({ category: "performance", rule: "perf.lighthouse-score-poor", severity: "high", title: "Lighthouse performance score 38", url: "/trail-tent/" });
  add({ category: "performance", rule: "perf.lcp-poor", severity: "high", title: "Largest Contentful Paint poor: 5.40 s", url: "/trail-tent/" });
  add({ category: "performance", rule: "perf.lcp-needs-improvement", severity: "medium", title: "Largest Contentful Paint needs improvement: 3.10 s", url: "/" });
  add({ category: "performance", rule: "perf.heavy-image", severity: "low", title: "Image 1240 KB over 300 KB budget", url: "/", selector: `${base}/images/hero-summer.jpg` });
  add({ category: "performance", rule: "perf.interaction-needs-improvement", severity: "low", title: "Slow response to a click: 280 ms", url: "/tents/", selector: "[data-facet-toggle]" });

  return {
    client: { name: "Northwind Outdoor", branding: { primary: "#1f3b2d", accent: "#d97706" } },
    project: { name: "Northwind store launch" },
    environment: { name: "production", baseUrl: base + "/" },
    run: { id: "6f1c2a9e-0000-4000-8000-000000000000", finishedAt: new Date("2026-11-06T03:00:00Z") },
    platform: "bigcommerce",
    pagesChecked: 184,
    templates: { pdp: 120, plp: 38, blog: 14, landing: 9, home: 1, search: 1, cart: 1 },
    categoriesRun: ["crawl", "links", "seo", "security", "accessibility", "performance", "platform", "visual"],
    perfProfile: "mobile",
    possiblyFixed: 4,
    perf: [
      { url: base + "/trail-tent/", template: "pdp", engine: "lighthouse", score: 38, lcp: 5400, cls: 0.02, tbt: 820, fcp: 2100, ttfb: 640, interaction: { target: "[data-product-attribute] label → label Green", latency: 140 }, insights: [{ id: "image-delivery-insight", title: "Improve image delivery", displayValue: "Est savings of 1,420 KiB" }, { id: "render-blocking-insight", title: "Render blocking requests", displayValue: "Est savings of 780 ms" }, { id: "third-parties-insight", title: "3rd parties" }] },
      { url: base + "/", template: "home", engine: "lighthouse", score: 61, lcp: 3100, cls: 0.14, tbt: 310, fcp: 1500, ttfb: 420, interaction: { target: "button[aria-expanded] → button Menu", latency: 96 }, insights: [{ id: "lcp-breakdown-insight", title: "LCP breakdown" }] },
      { url: base + "/tents/", template: "plp", engine: "lighthouse", score: 72, lcp: 2400, cls: 0.05, tbt: 260, fcp: 1300, ttfb: 380, interaction: { target: "[data-facet-toggle] → button Brand", latency: 280 } },
      { url: base + "/blog/winter-camping/", template: "blog", engine: "lighthouse", score: 94, lcp: 1900, cls: 0, tbt: 40, fcp: 1100, ttfb: 300, interaction: null },
    ],
    visual: {
      browsers: ["chromium", "firefox", "webkit"],
      viewports: ["mobile", "tablet", "desktop"],
      captures: (["/", "/tents/", "/trail-tent/"] as const).flatMap((path, i) =>
        (["chromium", "firefox", "webkit"] as const).flatMap((browser) =>
          (["mobile", "tablet", "desktop"] as const).map((viewport) => ({
            url: base + path,
            template: ["home", "plp", "pdp"][i]!,
            browser,
            viewport,
            status: path === "/" && viewport === "desktop" ? ("changed" as const) : ("match" as const),
            diffRatio: path === "/" && viewport === "desktop" ? 0.084 : 0,
            overflowPx: path === "/tents/" && viewport === "mobile" ? 42 : 0,
            jsErrors: path === "/trail-tent/" && browser === "webkit" ? ["TypeError: undefined is not an object (evaluating 'a.swatch')"] : [],
            brokenImages: [],
          })),
        ),
      ),
    },
    findings: f,
  };
}
