import type { Platform } from "@mattertest/core";

export interface PlatformSignal {
  platform: Platform;
  evidence: string[];
}

type Headers = Record<string, string | undefined>;

const RULES: { platform: Platform; html?: RegExp[]; headers?: [string, RegExp][]; cookies?: RegExp[] }[] = [
  {
    platform: "bigcommerce",
    html: [/cdn\d*\.bigcommerce\.com/i, /stencilBootstrap|window\.stencilUtils|jsContext\s*=/i, /data-stencil/i],
    headers: [["x-bc-store-version", /.+/]],
  },
  {
    platform: "shopify",
    html: [/cdn\.shopify\.com/i, /Shopify\.theme\s*=/i, /shopify-section/i],
    headers: [["x-shopify-stage", /.+/], ["x-shopid", /.+/], ["powered-by", /shopify/i]],
  },
  {
    platform: "wordpress",
    html: [/\/wp-content\//i, /\/wp-includes\//i, /<meta[^>]+name=["']generator["'][^>]+WordPress/i],
    headers: [["link", /wp-json/i]],
  },
  {
    platform: "laravel",
    headers: [["x-inertia", /.+/]],
    cookies: [/laravel_session=/i, /XSRF-TOKEN=/],
  },
  {
    platform: "nextjs",
    html: [/__NEXT_DATA__/, /\/_next\/static\//],
    headers: [["x-powered-by", /next\.js/i]],
  },
];

/** Detect the platform from a page's HTML and response headers. Highest evidence count wins. */
export function detectPlatform(html: string, headers: Headers = {}): PlatformSignal {
  const lower: Headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const setCookie = lower["set-cookie"] ?? "";
  let best: PlatformSignal = { platform: "custom", evidence: [] };

  for (const rule of RULES) {
    const evidence: string[] = [];
    for (const re of rule.html ?? []) if (re.test(html)) evidence.push(`html:${re.source}`);
    for (const [name, re] of rule.headers ?? []) {
      const v = lower[name];
      if (v && re.test(v)) evidence.push(`header:${name}`);
    }
    for (const re of rule.cookies ?? []) if (re.test(setCookie)) evidence.push(`cookie:${re.source}`);
    if (evidence.length > best.evidence.length) best = { platform: rule.platform, evidence };
  }
  return best;
}
