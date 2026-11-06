import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { runSiteCheck, wordpressPack, wordpressTemplate, type PackGet, type PackPage } from "../src/index";

const SITE = "https://northwind.com.au/";
const ctx = { baseUrl: SITE, robotsTxt: "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nSitemap: https://northwind.com.au/wp-sitemap.xml\n" };
const doc = (bodyClass: string, body: string, head = "") =>
  `<html><head><link rel="stylesheet" href="/wp-content/themes/astra/style.css">${head}</head><body class="${bodyClass}">${body}</body></html>`;
const page = (url: string, html: string): PackPage => ({ url, status: 200, headers: {}, html, template: wordpressTemplate(html) ?? "unknown" });
const rules = (p: PackPage) => wordpressPack.pageFindings(p, ctx).map((f) => f.rule);

describe("WordPress templates", () => {
  it("reads the template from WordPress body classes, most specific first", () => {
    expect(wordpressTemplate(doc("home page-template-default page", ""))).toBe("home");
    expect(wordpressTemplate(doc("product-template-default single single-product woocommerce", ""))).toBe("pdp");
    expect(wordpressTemplate(doc("archive tax-product_cat woocommerce", ""))).toBe("plp");
    expect(wordpressTemplate(doc("page-template-default page page-id-7", ""))).toBe("landing");
    expect(wordpressTemplate(doc("post-template-default single single-post", ""))).toBe("blog");
    expect(wordpressTemplate(doc("archive category category-news", ""))).toBe("archive");
    expect(wordpressTemplate("<html><body></body></html>")).toBeUndefined();
  });
});

describe("WordPress pack: pages", () => {
  it("passes a clean page", () => {
    expect(rules(page(`${SITE}about/`, doc("page", "<h1>About us</h1>", "<title>About | Northwind</title>")))).toEqual([]);
  });

  it("flags default content and tagline", () => {
    expect(rules(page(`${SITE}hello-world/`, doc("single single-post", "<h1>Hello world!</h1>", "<title>Northwind – Just another WordPress site</title>")))).toEqual(["wp.default-content", "wp.default-tagline"]);
  });

  it("flags canonicals and links left on the staging host", () => {
    const html = doc("page", `<a href="https://northwind.wpengine.com/shop/">Shop</a>`, `<link rel="canonical" href="https://staging.northwind.com.au/about/">`);
    expect(rules(page(`${SITE}about/`, html))).toEqual(["wp.staging-domain-canonical", "wp.staging-domain-links"]);
  });

  it("flags PHP warnings printed into the page", () => {
    const html = doc("page", `<br />\n<b>Warning</b>:  Undefined array key "x" in <b>/var/www/html/wp-content/themes/astra/header.php</b> on line <b>12</b><br /><h1>About</h1>`);
    const [f] = wordpressPack.pageFindings(page(`${SITE}about/`, html), ctx);
    expect(f).toMatchObject({ rule: "wp.php-errors-visible", severity: "high", title: "PHP warning printed on the page" });
  });

  it("checks WooCommerce product pages", () => {
    const woo = (body: string, head = "") => doc("single single-product woocommerce", `<div class="summary entry-summary">${body}</div>`, `<script src="/wp-content/plugins/woocommerce/assets/js/frontend/add-to-cart.min.js"></script>${head}`);
    expect(rules(page(`${SITE}product/lamp/`, woo(`<p class="price"><span class="amount">$0.00</span></p>`)))).toEqual(["wp.woo-pdp-no-add-to-cart", "wp.woo-pdp-zero-price", "wp.woo-pdp-schema-missing"]);
    const good = woo(`<p class="price"><span class="amount">$49.00</span></p><form class="cart"><button name="add-to-cart">Add</button></form>`, `<script type="application/ld+json">{"@graph":[{"@type":"Product"}]}</script>`);
    expect(rules(page(`${SITE}product/lamp/`, good))).toEqual([]);
    const oos = woo(`<p class="stock out-of-stock">Out of stock</p>`, `<script type="application/ld+json">{"@type":"Product"}</script>`);
    expect(rules(page(`${SITE}product/lamp/`, oos))).toEqual([]);
  });
});

describe("WordPress pack: site", () => {
  const noindex = `<meta name='robots' content='noindex, nofollow' />`;
  it("flags 'Discourage search engines' when the home page and most pages are noindex", () => {
    const pages = [page(SITE, doc("home", "", noindex)), page(`${SITE}a/`, doc("page", "", noindex)), page(`${SITE}b/`, doc("page", "", noindex))];
    expect(wordpressPack.siteFindings(pages, ctx).map((f) => [f.rule, f.severity])).toEqual([["wp.search-engines-discouraged", "critical"]]);
    // A few noindexed pages (thank-you, account) are normal.
    const mixed = [page(SITE, doc("home", "")), page(`${SITE}thanks/`, doc("page", "", noindex))];
    expect(wordpressPack.siteFindings(mixed, ctx)).toEqual([]);
  });

  it("checks robots.txt, version disclosure and plugin count", () => {
    const plugins = Array.from({ length: 22 }, (_, i) => `<script src="/wp-content/plugins/plugin-${i}/x.js"></script>`).join("");
    const home = page(SITE, doc("home", plugins, `<meta name="generator" content="WordPress 6.8.1" />`));
    const f = wordpressPack.siteFindings([home], { ...ctx, robotsTxt: "User-agent: *\nDisallow: /wp-admin/\nDisallow: /wp-includes/\n" });
    expect(f.map((x) => x.rule)).toEqual(["wp.robots-blocks-assets", "wp.robots-no-sitemap", "wp.version-exposed", "wp.many-plugins"]);
  });

  it("probes a fixed list of public paths and never keeps usernames", async () => {
    const seen: string[] = [];
    const responses: Record<string, { status: number; body: string }> = {
      "/wp-json/wp/v2/users": { status: 200, body: JSON.stringify([{ id: 1, name: "Admin Person", slug: "admin" }, { id: 2, slug: "editor" }]) },
      "/xmlrpc.php": { status: 405, body: "XML-RPC server accepts POST requests only." },
      "/wp-content/debug.log": { status: 200, body: "[06-Nov-2026 03:00:00 UTC] PHP Warning:  Undefined variable $x in /var/www/html/wp-content/themes/astra/functions.php on line 4" },
      "/wp-content/uploads/": { status: 200, body: "<html><head><title>Index of /wp-content/uploads</title></head></html>" },
      "/readme.html": { status: 200, body: "<h1>WordPress</h1><br /> Version 6.8.1" },
    };
    const get: PackGet = async (p) => {
      seen.push(p);
      const r = responses[p];
      return r ? { ...r, headers: {} } : null;
    };
    const f = await wordpressPack.probe!(ctx, get);
    expect(seen.sort()).toEqual(Object.keys(responses).sort());
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["wp.users-listed", "medium"],
      ["wp.xmlrpc-enabled", "low"],
      ["wp.debug-log-public", "high"],
      ["wp.uploads-listing", "medium"],
      ["wp.readme-exposed", "low"],
    ]);
    expect(f[0]!.evidence).toEqual({ count: 2 });
    expect(JSON.stringify(f)).not.toMatch(/admin|editor|Admin Person/);
  });

  it("reports nothing when the probed paths are locked down", async () => {
    const get: PackGet = async () => ({ status: 404, body: "Not found", headers: {} });
    expect(await wordpressPack.probe!(ctx, get)).toEqual([]);
  });
});

/** A fake WordPress site crawled end to end. */
const PAGES: Record<string, { status?: number; type?: string; body: string }> = {
  "/": { body: doc("home blog", `<h1>Northwind</h1><a href="/hello-world/">Hello</a><a href="/about/">About</a>`, `<title>Northwind – Just another WordPress site</title><meta name="generator" content="WordPress 6.8.1" />`) },
  "/hello-world/": { body: doc("post-template-default single single-post", "<h1>Hello world!</h1>", "<title>Hello world! – Northwind</title>") },
  "/about/": { body: doc("page-template-default page", `<b>Notice</b>:  Function x is deprecated in <b>/var/www/html/wp-includes/functions.php</b> on line <b>6</b><h1>About</h1>`, "<title>About – Northwind</title>") },
  "/robots.txt": { type: "text/plain", body: "User-agent: *\nDisallow: /wp-admin/\n" },
  "/wp-json/wp/v2/users": { type: "application/json", body: JSON.stringify([{ id: 1, slug: "admin" }]) },
  "/xmlrpc.php": { status: 405, type: "text/plain", body: "XML-RPC server accepts POST requests only." },
};

let server: Server;
let base: string;
let browser: Browser;
const methods: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    methods.push(req.method ?? "");
    const r = PAGES[(req.url ?? "/").split("?")[0]!];
    if (!r) return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    res.writeHead(r.status ?? 200, { "content-type": r.type ?? "text/html", link: '<http://x/wp-json/>; rel="https://api.w.org/"' }).end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

describe("WordPress pack end to end", () => {
  it("detects WordPress, reads templates from body classes, and runs page, site and probe checks with GETs only", async () => {
    const result = await runSiteCheck(browser, { baseUrl: base, categories: ["crawl", "platform"], maxPages: 10, concurrency: 2, delayMs: 0 });
    expect(result.platform).toBe("wordpress");
    expect(result.templates).toMatchObject({ home: 1, blog: 1, landing: 1 });
    const rules = new Set(result.findings.map((f) => f.rule));
    for (const r of ["wp.default-content", "wp.default-tagline", "wp.php-errors-visible", "wp.version-exposed", "wp.robots-no-sitemap", "wp.users-listed", "wp.xmlrpc-enabled"]) expect(rules).toContain(r);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  }, 60_000);
});
