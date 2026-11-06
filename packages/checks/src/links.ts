import type { FindingInput } from "@mattertest/core";

export interface LinkResult {
  url: string;
  status: number | null;
  chain: string[]; // every hop, starting with url
  loop: boolean;
  error?: string;
}

/** Follow redirects by hand so chains and loops are visible. HEAD first, GET if HEAD is refused. */
export async function checkUrl(url: string, userAgent: string, maxHops = 10): Promise<LinkResult> {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let res: Response;
    try {
      res = await fetch(current, { method: "HEAD", redirect: "manual", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 405 || res.status === 501)
        res = await fetch(current, { method: "GET", redirect: "manual", headers: { "user-agent": userAgent }, signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      return { url, status: null, chain, loop: false, error: (e as Error).message };
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current).toString();
      if (chain.includes(next)) return { url, status: res.status, chain: [...chain, next], loop: true };
      chain.push(next);
      current = next;
      continue;
    }
    return { url, status: res.status, chain, loop: false };
  }
  return { url, status: null, chain, loop: false, error: `more than ${maxHops} redirects` };
}

export async function checkUrls(urls: string[], userAgent: string, concurrency = 8): Promise<LinkResult[]> {
  const queue = [...new Set(urls)];
  const out: LinkResult[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) out.push(await checkUrl(u, userAgent));
    }),
  );
  return out;
}

/** Turn link results into findings, attributing each broken target to the pages that link to it. */
export function linkFindings(results: LinkResult[], referrers: Map<string, Set<string>>, kind: "link" | "image" = "link"): FindingInput[] {
  const out: FindingInput[] = [];
  for (const r of results) {
    const from = [...(referrers.get(r.url) ?? [])];
    const where = from[0] ?? r.url;
    const evidence = { target: r.url, chain: r.chain, linkedFrom: from.slice(0, 50), linkedFromCount: from.length };
    if (r.loop) out.push({ category: "links", rule: "links.redirect-loop", severity: "high", title: `Redirect loop on ${r.url}`, url: where, selector: r.url, evidence });
    else if (r.error || r.status === null) out.push({ category: "links", rule: `links.${kind}-unreachable`, severity: "medium", title: `${kind === "image" ? "Image" : "Link"} unreachable: ${r.url}`, url: where, selector: r.url, detail: r.error, evidence });
    else if (r.status >= 400) out.push({ category: "links", rule: `links.${kind}-${r.status >= 500 ? "5xx" : "4xx"}`, severity: r.status >= 500 ? "high" : "medium", title: `${kind === "image" ? "Broken image" : "Broken link"} (${r.status}): ${r.url}`, url: where, selector: r.url, evidence });
    else if (r.chain.length > 3) out.push({ category: "links", rule: "links.redirect-chain", severity: "low", title: `Redirect chain of ${r.chain.length - 1} hops`, url: where, selector: r.url, evidence });
  }
  return out;
}
