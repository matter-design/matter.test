import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { runSiteCheck, shopifyPack, shopifyTemplate, type PackPage } from "../src/index";

const ROBOTS = "User-agent: *\nDisallow: /admin\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\nSitemap: https://shop.test/sitemap.xml\n";
const ctx = { baseUrl: "https://shop.test/", robotsTxt: ROBOTS };
const doc = (template: string, body: string, head = "") =>
  `<html><head><script src="https://cdn.shopify.com/s/files/1/theme.js"></script>${head}</head><body class="template-${template}">${body}</body></html>`;
const page = (url: string, html: string): PackPage => ({ url, status: 200, headers: {}, html, template: shopifyTemplate(html) ?? "unknown" });
const rules = (p: PackPage) => shopifyPack.pageFindings(p, ctx).map((f) => f.rule);

const PRODUCT_LD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Trail Tent"}</script>`;

describe("Shopify templates", () => {
  it("reads the template from the body class or Shopify's analytics page type", () => {
    expect(shopifyTemplate(doc("product", ""))).toBe("pdp");
    expect(shopifyTemplate(doc("collection", ""))).toBe("plp");
    expect(shopifyTemplate(doc("index", ""))).toBe("home");
    expect(shopifyTemplate(doc("customers-login", ""))).toBe("account");
    expect(shopifyTemplate(`<html><body class="gradient"><script>var meta = {"page":{"pageType":"product"}};</script></body></html>`)).toBe("pdp");
    expect(shopifyTemplate("<html><body></body></html>")).toBeUndefined();
  });
});

describe("Shopify pack: pages", () => {
  const goodPdp = doc("product", `<h1>Trail Tent</h1><form action="/cart/add" method="post"><button name="add">Add to cart</button></form>`, `<link rel="canonical" href="https://shop.test/products/trail-tent"><meta property="og:price:amount" content="249.00">${PRODUCT_LD}`);

  it("passes a healthy product page", () => {
    expect(rules(page("https://shop.test/products/trail-tent", goodPdp))).toEqual([]);
  });

  it("flags a password-protected storefront as critical", () => {
    const html = doc("password", `<form action="/password" method="post"><input type="password" name="password"></form><p>Opening soon</p>`);
    const f = shopifyPack.pageFindings(page("https://shop.test/", html), ctx);
    expect(f.map((x) => [x.rule, x.severity])).toEqual([["shopify.password-protected", "critical"]]);
  });

  it("flags myshopify.com canonicals and links, and theme placeholder text", () => {
    const html = doc("index", `<a href="https://northwind.myshopify.com/collections/all">Shop</a><h2>Talk about your brand</h2>`, `<link rel="canonical" href="https://northwind.myshopify.com/">`);
    expect(rules(page("https://shop.test/", html))).toEqual(["shopify.store-domain-canonical", "shopify.store-domain-links", "shopify.placeholder-content"]);
  });

  it("flags unbuyable, $0 and schema-less products, but not sold-out ones", () => {
    const broken = doc("product", `<h1>Lamp</h1>`, `<meta property="og:price:amount" content="0.00">`);
    expect(rules(page("https://shop.test/products/lamp", broken))).toEqual(["shopify.pdp-no-add-to-cart", "shopify.pdp-zero-price", "shopify.pdp-schema-missing"]);
    const soldOut = doc("product", `<h1>Lamp</h1><div class="product-form"><button name="add" disabled>Sold out</button></div>`, `<meta property="og:price:amount" content="39.00">${PRODUCT_LD}`);
    expect(rules(page("https://shop.test/products/lamp", soldOut))).toEqual([]);
  });

  it("flags collection-scoped product URLs only when the canonical was changed", () => {
    const url = "https://shop.test/collections/tents/products/trail-tent";
    expect(rules(page(url, goodPdp))).toEqual([]);
    const selfCanonical = goodPdp.replace("https://shop.test/products/trail-tent", url);
    expect(rules(page(url, selfCanonical))).toEqual(["shopify.collection-product-not-canonical"]);
  });

  it("flags indexable filtered and tagged collection pages", () => {
    expect(rules(page("https://shop.test/collections/tents?filter.v.price.gte=100", doc("collection", "", `<link rel="canonical" href="https://shop.test/collections/tents?filter.v.price.gte=100">`)))).toEqual(["shopify.filter-url-indexable"]);
    expect(rules(page("https://shop.test/collections/tents/blue", doc("collection", "")))).toEqual(["shopify.filter-url-indexable"]);
    expect(rules(page("https://shop.test/collections/tents?sort_by=price", doc("collection", "", `<link rel="canonical" href="https://shop.test/collections/tents">`)))).toEqual([]);
  });
});

describe("Shopify pack: site", () => {
  it("checks robots.txt defaults and transactional pages", () => {
    const cart = page("https://shop.test/cart", doc("cart", ""));
    expect(shopifyPack.siteFindings([cart], ctx).map((f) => f.rule)).toEqual(["shopify.transactional-indexable"]);
    const edited = shopifyPack.siteFindings([], { ...ctx, robotsTxt: "User-agent: *\nDisallow: /admin\n" });
    expect(edited.map((f) => f.rule)).toEqual(["shopify.robots-defaults-removed", "shopify.robots-no-sitemap"]);
    expect(edited[0]!.evidence).toEqual({ missing: ["/cart", "/checkout", "/account"] });
  });

  it("counts app scripts and legacy ScriptTag apps on the home page", () => {
    const apps = Array.from({ length: 14 }, (_, i) => `<script src="https://app${i}.example.com/widget.js"></script>`).join("");
    const html = doc(
      "index",
      `${apps}<script src="https://shop.test/assets/own.js"></script><script src="https://cdn.shopify.com/extensions/x.js"></script>
       <script>var urls = ["https:\\/\\/reviews.example.net\\/loader.js?shop=northwind.myshopify.com"];</script>`,
    );
    const f = shopifyPack.siteFindings([page("https://shop.test/", html)], ctx);
    expect(f.map((x) => [x.rule, x.title])).toEqual([
      ["shopify.many-app-scripts", "15 third-party script hosts on the home page"],
      ["shopify.legacy-scripttag-apps", "1 app injected with legacy ScriptTags"],
    ]);
  });

  it("reports internal links to collection-scoped product URLs once per site", () => {
    const links = Array.from({ length: 6 }, (_, i) => `<a href="/collections/tents/products/tent-${i}">Tent ${i}</a>`).join("");
    const f = shopifyPack.siteFindings([page("https://shop.test/collections/tents", doc("collection", links))], ctx);
    expect(f.map((x) => x.rule)).toEqual(["shopify.collection-product-links"]);
  });
});

/** A fake Shopify store crawled end to end: detection, templates from markup, and pack findings. */
const STORE: Record<string, string> = {
  "/": doc("index", `<h1>Northwind</h1><a href="/collections/tents">Tents</a><a href="/products/lamp">Lamp</a><h2>Talk about your brand</h2>`, `<title>Northwind</title><script>Shopify.theme = {"name":"Dawn"};</script>`),
  "/collections/tents": doc("collection", `<h1>Tents</h1><a href="/collections/tents/products/trail-tent">Trail Tent</a>`, `<title>Tents</title>`),
  "/collections/tents/products/trail-tent": doc("product", `<h1>Trail Tent</h1><form action="/cart/add" method="post"><button name="add">Add</button></form>`, `<title>Trail Tent</title><link rel="canonical" href="/products/trail-tent"><meta property="og:price:amount" content="249.00">${PRODUCT_LD}`),
  "/products/lamp": doc("product", `<h1>Lamp</h1>`, `<title>Lamp</title><link rel="canonical" href="https://northwind.myshopify.com/products/lamp"><meta property="og:price:amount" content="0.00">`),
};

let server: Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    if (path === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /admin\n");
    const html = STORE[path];
    if (!html) return void res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
    res.writeHead(200, { "content-type": "text/html", "x-shopid": "123" }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

describe("Shopify pack end to end", () => {
  it("detects Shopify, names templates from markup and reports the planted problems", async () => {
    const result = await runSiteCheck(browser, { baseUrl: base, categories: ["crawl", "platform"], maxPages: 10, concurrency: 2, delayMs: 0 });
    expect(result.platform).toBe("shopify");
    expect(result.templates).toMatchObject({ home: 1, plp: 1, pdp: 2 });
    const rules = new Set(result.findings.map((f) => f.rule));
    for (const r of ["shopify.placeholder-content", "shopify.store-domain-canonical", "shopify.pdp-zero-price", "shopify.pdp-no-add-to-cart", "shopify.robots-defaults-removed"]) expect(rules).toContain(r);
    expect(rules).not.toContain("shopify.collection-product-not-canonical");
  }, 60_000);
});
