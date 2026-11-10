import { CONFLUENCE_MAX_PAGES, confluencePageRef, confluencePageUrl } from "@mattertest/core";

/**
 * Confluence Cloud, read-only, through the REST API v2 with one account's API token (basic auth).
 * https://developer.atlassian.com/cloud/confluence/rest/v2/
 */
export type ConfluenceConfig = { origin: string; email: string; token: string };

export type ConfluencePage = {
  id: string;
  title: string;
  version: number;
  /** Link to open the page in Confluence. */
  webUrl: string;
  /** The rendered page (export_view: macros expanded, as a reader sees it). */
  html: string;
  /** Id of the page this one was reached from, when read as a child page. */
  parentId?: string;
};

/** A Confluence failure worded for the Sources list. */
export class ConfluenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfluenceError";
  }
}

/**
 * Connection settings from the environment. CONFLUENCE_* wins; the JIRA_* settings are used otherwise,
 * since one Atlassian API token works for both products on the same site.
 */
export function confluenceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConfluenceConfig | null {
  const base = env.CONFLUENCE_BASE_URL || env.JIRA_BASE_URL;
  const email = env.CONFLUENCE_EMAIL || env.JIRA_EMAIL;
  const token = env.CONFLUENCE_API_TOKEN || env.JIRA_API_TOKEN;
  if (!base || !email || !token) return null;
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return null;
  }
  return { origin, email, token };
}

export const NOT_SET_UP =
  "Confluence isn't set up on the worker: put CONFLUENCE_BASE_URL, CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in .env and restart the worker.";

type Fetch = typeof fetch;

function headers(cfg: ConfluenceConfig) {
  return { Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64")}`, Accept: "application/json" };
}

async function getJson<T>(cfg: ConfluenceConfig, path: string, f: Fetch, what: string): Promise<T> {
  let res: Response;
  try {
    res = await f(`${cfg.origin}${path}`, { headers: headers(cfg) });
  } catch {
    throw new ConfluenceError(`Couldn't reach Confluence at ${cfg.origin}. Check the worker's network connection.`);
  }
  if (res.status === 401) throw new ConfluenceError("Confluence rejected the API token. Check CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN in .env.");
  if (res.status === 403 || res.status === 404)
    throw new ConfluenceError(`Couldn't open ${what}: it doesn't exist, or the MatterTest Confluence account (${cfg.email}) can't see it.`);
  if (res.status === 429) throw new ConfluenceError("Confluence's rate limit was hit. Try again in a minute.");
  if (!res.ok) throw new ConfluenceError(`Confluence returned an error (${res.status}) for ${what}.`);
  return (await res.json()) as T;
}

type PageResponse = {
  id: string;
  title: string;
  version?: { number?: number };
  body?: { export_view?: { value?: string } };
  _links?: { webui?: string; base?: string };
};

/** The page's id from a link, resolving short links (/wiki/x/…) by following their redirect. */
export async function resolvePageId(cfg: ConfluenceConfig, link: string, f: Fetch = fetch): Promise<string> {
  const ref = confluencePageRef(link);
  if (!ref) throw new ConfluenceError("That isn't a Confluence page link. Copy the link from the page's address bar.");
  if (ref.origin !== cfg.origin) throw new ConfluenceError(`MatterTest reads Confluence at ${cfg.origin}, but this link is on ${ref.origin}.`);
  if ("pageId" in ref) return ref.pageId;
  let res: Response;
  try {
    res = await f(`${cfg.origin}/wiki/x/${ref.tiny}`, { headers: headers(cfg), redirect: "follow" });
  } catch {
    throw new ConfluenceError(`Couldn't reach Confluence at ${cfg.origin}. Check the worker's network connection.`);
  }
  const target = confluencePageRef(res.url);
  if (!res.ok || !target || !("pageId" in target)) throw new ConfluenceError("Couldn't follow that short link to a page. Use the page's full link instead.");
  return target.pageId;
}

/** One page, rendered. */
export async function fetchPage(cfg: ConfluenceConfig, pageId: string, f: Fetch = fetch): Promise<ConfluencePage> {
  const p = await getJson<PageResponse>(cfg, `/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=export_view`, f, `page ${pageId}`);
  const webui = p._links?.webui;
  return {
    id: String(p.id),
    title: p.title,
    version: p.version?.number ?? 1,
    webUrl: webui ? `${p._links?.base ?? `${cfg.origin}/wiki`}${webui}` : confluencePageUrl(cfg.origin, String(p.id)),
    html: p.body?.export_view?.value ?? "",
  };
}

type ChildrenResponse = { results: { id: string; title: string; type?: string; status?: string }[]; _links?: { next?: string } };

/** Pages and folders directly under a page or folder, following pagination. */
async function directChildren(cfg: ConfluenceConfig, kind: "pages" | "folders", id: string, f: Fetch) {
  const out: ChildrenResponse["results"] = [];
  let path: string | undefined = `/wiki/api/v2/${kind}/${encodeURIComponent(id)}/direct-children?limit=250`;
  while (path) {
    const res: ChildrenResponse = await getJson<ChildrenResponse>(cfg, path, f, `the child pages of ${id}`);
    out.push(...res.results);
    const next: string | undefined = res._links?.next;
    path = next ? (next.startsWith("/wiki/") ? next : `/wiki${next}`) : undefined;
  }
  return out;
}

/**
 * A page and, if asked, the pages under it (breadth first, through folders), up to `max` pages in all.
 * Returns the pages and whether the cap cut the tree short.
 */
export async function readPageTree(
  cfg: ConfluenceConfig,
  rootId: string,
  opts: { includeChildren: boolean; max?: number },
  f: Fetch = fetch,
): Promise<{ pages: ConfluencePage[]; truncated: boolean }> {
  const max = opts.max ?? CONFLUENCE_MAX_PAGES;
  const pages = [await fetchPage(cfg, rootId, f)];
  if (!opts.includeChildren) return { pages, truncated: false };
  const queue: { kind: "pages" | "folders"; id: string; parentId: string }[] = [{ kind: "pages", id: rootId, parentId: rootId }];
  const seen = new Set([rootId]);
  while (queue.length) {
    const at = queue.shift()!;
    for (const c of await directChildren(cfg, at.kind, at.id, f)) {
      if (seen.has(c.id) || (c.status && c.status !== "current")) continue;
      seen.add(c.id);
      if (c.type === "folder") {
        queue.push({ kind: "folders", id: c.id, parentId: at.parentId });
        continue;
      }
      if (c.type && c.type !== "page") continue; // whiteboards, databases, embeds
      if (pages.length >= max) return { pages, truncated: true };
      pages.push({ ...(await fetchPage(cfg, c.id, f)), parentId: at.parentId });
      queue.push({ kind: "pages", id: c.id, parentId: c.id });
    }
  }
  return { pages, truncated: false };
}
