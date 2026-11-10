import { describe, expect, it } from "vitest";
import { confluencePageRef, confluencePageUrl } from "@mattertest/core";
import { ConfluenceError, confluenceConfigFromEnv, fetchPage, readPageTree, resolvePageId, type ConfluenceConfig } from "../src/confluence";
import { parseHtml } from "../src/parse";
import { readSource } from "../src/pipeline";

const ORIGIN = "https://northwind.atlassian.net";
const cfg: ConfluenceConfig = { origin: ORIGIN, email: "qa@matterdesign.com.au", token: "test-token" };

const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });

/** A fake Confluence: pages by id, children by parent id (pages or folders), optional page size for pagination. */
function fakeConfluence(opts: { pages: Record<string, { title: string; version?: number; html?: string }>; children?: Record<string, { id: string; title?: string; type?: string; status?: string }[]>; pageSize?: number; status?: number }) {
  const calls: { url: string; auth: string | null }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization") });
    if (opts.status) return json({ message: "nope" }, opts.status);
    const page = url.pathname.match(/^\/wiki\/api\/v2\/pages\/(\d+)$/);
    if (page) {
      const p = opts.pages[page[1]!];
      if (!p) return json({ errors: [] }, 404);
      return json({ id: page[1], title: p.title, version: { number: p.version ?? 1 }, body: { export_view: { value: p.html ?? `<p>${p.title}</p>` } }, _links: { webui: `/spaces/SHOP/pages/${page[1]}/${encodeURIComponent(p.title)}`, base: `${ORIGIN}/wiki` } });
    }
    const kids = url.pathname.match(/^\/wiki\/api\/v2\/(?:pages|folders)\/(\d+)\/direct-children$/);
    if (kids) {
      const all = opts.children?.[kids[1]!] ?? [];
      const size = opts.pageSize ?? 250;
      const from = Number(url.searchParams.get("cursor") ?? 0);
      const next = from + size < all.length ? `/api/v2/${url.pathname.split("/")[4]}/${kids[1]}/direct-children?limit=250&cursor=${from + size}` : undefined;
      return json({ results: all.slice(from, from + size).map((c) => ({ title: `Page ${c.id}`, type: "page", status: "current", ...c })), _links: next ? { next } : {} });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { f, calls };
}

describe("confluencePageRef", () => {
  it("reads the page id from the common Confluence Cloud link shapes", () => {
    expect(confluencePageRef(`${ORIGIN}/wiki/spaces/SHOP/pages/123456/Checkout+v2`)).toEqual({ origin: ORIGIN, pageId: "123456" });
    expect(confluencePageRef(`${ORIGIN}/wiki/spaces/SHOP/pages/123456`)).toEqual({ origin: ORIGIN, pageId: "123456" });
    expect(confluencePageRef(`${ORIGIN}/wiki/spaces/SHOP/pages/edit-v2/123456?draftShareId=x`)).toEqual({ origin: ORIGIN, pageId: "123456" });
    expect(confluencePageRef(`${ORIGIN}/wiki/pages/viewpage.action?pageId=123456`)).toEqual({ origin: ORIGIN, pageId: "123456" });
    expect(confluencePageRef(`${ORIGIN}/wiki/spaces/SHOP/pages/123456/Checkout+v2#Promo-codes`)).toEqual({ origin: ORIGIN, pageId: "123456" });
    expect(confluencePageRef(`${ORIGIN}/wiki/x/AbCd12`)).toEqual({ origin: ORIGIN, tiny: "AbCd12" });
  });

  it("rejects links that aren't to a page", () => {
    expect(confluencePageRef(`${ORIGIN}/wiki/spaces/SHOP/overview`)).toBeNull();
    expect(confluencePageRef(`${ORIGIN}/wiki/pages/viewpage.action?pageId=abc`)).toBeNull();
    expect(confluencePageRef(`${ORIGIN}/browse/SHOP-12`)).toBeNull();
    expect(confluencePageRef("not a link")).toBeNull();
    expect(confluencePageRef("ftp://northwind.atlassian.net/wiki/spaces/SHOP/pages/1")).toBeNull();
  });

  it("stores one stable link per page", () => {
    expect(confluencePageUrl(ORIGIN, "123")).toBe(`${ORIGIN}/wiki/pages/viewpage.action?pageId=123`);
  });
});

describe("confluenceConfigFromEnv", () => {
  it("uses CONFLUENCE_* settings, falls back to JIRA_*, and is null when anything is missing", () => {
    expect(confluenceConfigFromEnv({ CONFLUENCE_BASE_URL: `${ORIGIN}/wiki`, CONFLUENCE_EMAIL: "a@b.c", CONFLUENCE_API_TOKEN: "t" })).toEqual({ origin: ORIGIN, email: "a@b.c", token: "t" });
    expect(confluenceConfigFromEnv({ JIRA_BASE_URL: ORIGIN, JIRA_EMAIL: "j@b.c", JIRA_API_TOKEN: "jt" })).toEqual({ origin: ORIGIN, email: "j@b.c", token: "jt" });
    expect(confluenceConfigFromEnv({ CONFLUENCE_BASE_URL: ORIGIN, CONFLUENCE_EMAIL: "a@b.c" })).toBeNull();
    expect(confluenceConfigFromEnv({ CONFLUENCE_BASE_URL: "nope", CONFLUENCE_EMAIL: "a@b.c", CONFLUENCE_API_TOKEN: "t" })).toBeNull();
  });
});

describe("parseHtml", () => {
  it("turns Confluence's rendered page into sectioned blocks: lists, tables, code, panels", () => {
    const html = `
      <h1 id="Checkout-Promo">Promo codes</h1>
      <div class="confluence-information-macro"><p>Applies to <strong>web</strong>&nbsp;only.</p></div>
      <h2>Invalid codes</h2>
      <ul><li><p>If a code has expired, show &quot;This code expired on {date}&quot;.</p></li><li>Unknown codes: &ldquo;We don&#39;t recognise that code&rdquo;</li></ul>
      <div class="table-wrap"><table><tbody><tr><th><p>Total</p></th><td><p>Afterpay</p><p>shown</p></td></tr></tbody></table></div>
      <pre class="syntaxhighlighter-pre">PROMO-10
PROMO-20</pre>
      <script>alert(1)</script><style>p{}</style><!-- <p>hidden</p> -->
      <h1>Payment</h1><p>Cards &amp; PayPal.</p>`;
    const blocks = parseHtml(html);
    expect(blocks).toEqual([
      { headings: ["Promo codes"], text: "Applies to web only." },
      { headings: ["Promo codes", "Invalid codes"], text: '- If a code has expired, show "This code expired on {date}".' },
      { headings: ["Promo codes", "Invalid codes"], text: "- Unknown codes: &ldquo;We don't recognise that code&rdquo;" },
      { headings: ["Promo codes", "Invalid codes"], text: "Total" },
      { headings: ["Promo codes", "Invalid codes"], text: "Afterpay\nshown" },
      { headings: ["Promo codes", "Invalid codes"], text: "PROMO-10\nPROMO-20" },
      { headings: ["Payment"], text: "Cards & PayPal." },
    ]);
  });

  it("feeds Confluence sources through the normal chunker", async () => {
    const html = "<h2>Shipping</h2><p>Standard shipping is free on orders over $99.</p><h2>Payment</h2><p>Afterpay between $35 and $2,000.</p>";
    const { chunks } = await readSource({ type: "confluence", file: Buffer.from(html) });
    expect(chunks.map((c) => c.sectionPath)).toEqual(["Shipping", "Payment"]);
  });
});

describe("reading pages", () => {
  it("fetches the rendered page with basic auth and builds its link", async () => {
    const { f, calls } = fakeConfluence({ pages: { "100": { title: "Checkout v2", version: 7, html: "<p>Hi</p>" } } });
    const page = await fetchPage(cfg, "100", f);
    expect(page).toEqual({ id: "100", title: "Checkout v2", version: 7, webUrl: `${ORIGIN}/wiki/spaces/SHOP/pages/100/Checkout%20v2`, html: "<p>Hi</p>" });
    expect(calls[0]).toEqual({ url: "/wiki/api/v2/pages/100?body-format=export_view", auth: `Basic ${Buffer.from("qa@matterdesign.com.au:test-token").toString("base64")}` });
  });

  it("reads child pages breadth first, through folders and across result pages, skipping whiteboards and drafts", async () => {
    const { f } = fakeConfluence({
      pages: { "100": { title: "Root" }, "101": { title: "A" }, "102": { title: "B" }, "103": { title: "C" }, "104": { title: "A1" } },
      children: {
        "100": [{ id: "101" }, { id: "900", type: "folder" }, { id: "700", type: "whiteboard" }, { id: "103" }, { id: "105", status: "draft" }],
        "900": [{ id: "102" }],
        "101": [{ id: "104" }],
      },
      pageSize: 2,
    });
    const { pages, truncated } = await readPageTree(cfg, "100", { includeChildren: true }, f);
    expect(pages.map((p) => [p.id, p.parentId])).toEqual([["100", undefined], ["101", "100"], ["103", "100"], ["104", "101"], ["102", "100"]]);
    expect(truncated).toBe(false);
  });

  it("stops at the page cap and says so", async () => {
    const kids = Array.from({ length: 10 }, (_, i) => ({ id: String(200 + i) }));
    const pages = Object.fromEntries([["100", { title: "Root" }], ...kids.map((k) => [k.id, { title: k.id }])]);
    const { f } = fakeConfluence({ pages, children: { "100": kids } });
    const out = await readPageTree(cfg, "100", { includeChildren: true, max: 4 }, f);
    expect(out.pages).toHaveLength(4);
    expect(out.truncated).toBe(true);
  });

  it("reads only the page when child pages aren't asked for", async () => {
    const { f, calls } = fakeConfluence({ pages: { "100": { title: "Root" } }, children: { "100": [{ id: "101" }] } });
    const out = await readPageTree(cfg, "100", { includeChildren: false }, f);
    expect(out.pages).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("explains auth, permission and site mismatches", async () => {
    await expect(fetchPage(cfg, "1", fakeConfluence({ pages: {}, status: 401 }).f)).rejects.toThrow(/rejected the API token/);
    await expect(fetchPage(cfg, "1", fakeConfluence({ pages: {} }).f)).rejects.toThrow(/doesn't exist, or the MatterTest Confluence account \(qa@matterdesign.com.au\) can't see it/);
    await expect(resolvePageId(cfg, "https://other.atlassian.net/wiki/spaces/X/pages/1", fetch)).rejects.toThrow(/reads Confluence at https:\/\/northwind.atlassian.net, but this link is on https:\/\/other.atlassian.net/);
    await expect(resolvePageId(cfg, `${ORIGIN}/wiki/spaces/X`, fetch)).rejects.toBeInstanceOf(ConfluenceError);
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await expect(fetchPage(cfg, "1", offline)).rejects.toThrow(/Couldn't reach Confluence/);
  });

  it("resolves short links by following the redirect", async () => {
    const f = (async () => Object.defineProperty(new Response("<html/>"), "url", { value: `${ORIGIN}/wiki/spaces/SHOP/pages/555/Title` })) as typeof fetch;
    expect(await resolvePageId(cfg, `${ORIGIN}/wiki/x/AbCd`, f)).toBe("555");
    expect(await resolvePageId(cfg, `${ORIGIN}/wiki/spaces/SHOP/pages/42/T`, fetch)).toBe("42");
  });
});

describe("parseHtml headings", () => {
  it("keeps sibling sections apart when a page starts at h2 or skips levels", () => {
    const blocks = parseHtml("<h2>A</h2><p>a</p><h4>A deep</h4><p>ad</p><h3>A sub</h3><p>as</p><h2>B</h2><p>b</p><h1>C</h1><p>c</p>");
    expect(blocks.map((b) => b.headings)).toEqual([["A"], ["A", "A deep"], ["A", "A sub"], ["B"], ["C"]]);
  });
});
