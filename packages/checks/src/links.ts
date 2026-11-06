import type { FindingInput } from "@mattertest/core";

export interface LinkResult {
  url: string;
  status: number | null;
  /** Still 429 after retries: the server refused to answer, so the link is unverified, not broken. */
  rateLimited?: boolean;
  chain: string[]; // every hop, starting with url
  loop: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait time for a 429: Retry-After (seconds or date) capped at 15 s, else exponential backoff. */
export function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 15_000);
  }
  return Math.min(1000 * 2 ** attempt, 15_000);
}

/**
 * One limiter shared by all link-check workers, so a site that says "slow down" (429) gets a slower checker,
 * not four workers each retrying on their own. Trips (stops checking) after too many 429s in a row or when
 * the time budget runs out; whatever is left is reported as unverified rather than broken.
 */
export class RateLimiter {
  private pauseUntil = 0;
  private consecutive429 = 0;
  private readonly started: number;
  delayMs: number;
  tripped: false | "rate-limited" | "time-budget" = false;

  constructor(
    private readonly baseDelayMs = 150,
    private readonly maxConsecutive429 = 8,
    private readonly budgetMs = 180_000,
    private readonly now: () => number = Date.now,
  ) {
    this.delayMs = baseDelayMs;
    this.started = now();
  }

  /** Wait for any global pause; false means stop (tripped). */
  async wait(): Promise<boolean> {
    if (!this.tripped && this.now() - this.started > this.budgetMs) this.tripped = "time-budget";
    if (this.tripped) return false;
    const ms = this.pauseUntil - this.now();
    if (ms > 0) await sleep(ms);
    return !this.tripped;
  }

  on429(retryAfter: string | null) {
    this.consecutive429++;
    this.delayMs = Math.min(Math.max(this.delayMs * 2, 500), 5_000);
    this.pauseUntil = Math.max(this.pauseUntil, this.now() + retryDelayMs(retryAfter, Math.min(this.consecutive429 - 1, 4)));
    if (this.consecutive429 >= this.maxConsecutive429) this.tripped = "rate-limited";
  }

  onOk() {
    this.consecutive429 = 0;
    this.delayMs = Math.max(this.baseDelayMs, Math.floor(this.delayMs * 0.8));
  }
}

/** HEAD first, GET if HEAD is refused. On 429, tell the limiter and retry once after its pause. Null = limiter tripped. */
async function request(url: string, userAgent: string, retries: number, limiter: RateLimiter): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    if (!(await limiter.wait())) return null;
    const init = { redirect: "manual" as const, headers: { "user-agent": userAgent, accept: "text/html,*/*;q=0.8" }, signal: AbortSignal.timeout(10_000) };
    let res = await fetch(url, { ...init, method: "HEAD" });
    if (res.status === 405 || res.status === 501) res = await fetch(url, { ...init, method: "GET" });
    // Cloudflare answers a bot challenge with 403 + cf-mitigated: challenge. Same as a 429 for us: unverified, slow down.
    const challenged = res.status === 403 && /challenge/i.test(res.headers.get("cf-mitigated") ?? "");
    if (res.status !== 429 && !challenged) {
      limiter.onOk();
      return res;
    }
    limiter.on429(res.headers.get("retry-after"));
    if (attempt >= retries) return res;
  }
}

/** Follow redirects by hand so chains and loops are visible. */
export async function checkUrl(url: string, userAgent: string, maxHops = 10, retries = 1, limiter = new RateLimiter()): Promise<LinkResult> {
  const chain = [url];
  let current = url;
  for (let hop = 0; hop <= maxHops; hop++) {
    let res: Response | null;
    try {
      res = await request(current, userAgent, retries, limiter);
    } catch (e) {
      return { url, status: null, chain, loop: false, error: (e as Error).message };
    }
    if (!res || res.status === 429 || (res.status === 403 && /challenge/i.test(res.headers.get("cf-mitigated") ?? ""))) return { url, status: res?.status ?? 429, chain, loop: false, rateLimited: true };
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

/**
 * Check URLs politely: a few at a time, with a shared limiter that slows everyone down on 429
 * and stops when the site keeps refusing or the time budget is spent.
 */
export async function checkUrls(urls: string[], userAgent: string, opts: { concurrency?: number; limiter?: RateLimiter } = {}): Promise<LinkResult[]> {
  const queue = [...new Set(urls)];
  const out: LinkResult[] = [];
  const limiter = opts.limiter ?? new RateLimiter();
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, queue.length) }, async () => {
      for (let u = queue.shift(); u; u = queue.shift()) {
        out.push(limiter.tripped ? { url: u, status: 429, chain: [u], loop: false, rateLimited: true } : await checkUrl(u, userAgent, 10, 1, limiter));
        if (!limiter.tripped) await sleep(limiter.delayMs);
      }
    }),
  );
  return out;
}

/** Turn link results into findings, attributing each broken target to the pages that link to it. */
export function linkFindings(results: LinkResult[], referrers: Map<string, Set<string>>, kind: "link" | "image" = "link"): FindingInput[] {
  const out: FindingInput[] = [];
  const limited = results.filter((r) => r.rateLimited);
  if (limited.length) {
    // One note, not hundreds of fake "broken links": these were never answered.
    const first = limited[0]!;
    out.push({ category: "links", rule: `links.${kind}-rate-limited`, severity: "info", title: `${limited.length} of ${results.length} ${kind === "image" ? "images" : "links"} not verified: the site asked us to slow down (429)`, url: [...(referrers.get(first.url) ?? [])][0] ?? first.url, detail: `The server rate-limited the checker, so ${results.length - limited.length} were checked, most-linked first (menus and footers before one-off links). Re-run later to cover the rest.`, evidence: { count: limited.length, checked: results.length - limited.length, examples: limited.slice(0, 20).map((r) => r.url) } });
  }
  for (const r of results.filter((x) => !x.rateLimited)) {
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
