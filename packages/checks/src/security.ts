import type { FindingInput } from "@mattertest/core";

/**
 * Passive security hygiene only: reads headers and cookies the server already sends.
 * No payloads, no probing beyond a fixed list of commonly exposed files.
 */
export function securityHeaderFindings(url: string, headers: Record<string, string | undefined>): FindingInput[] {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const out: FindingInput[] = [];
  const add = (rule: string, severity: FindingInput["severity"], title: string, detail?: string) =>
    out.push({ category: "security", rule: `security.${rule}`, severity, title, url, detail });

  const isHttps = url.startsWith("https://");
  if (!isHttps) add("not-https", "high", "Page served over plain HTTP");
  if (isHttps && !h["strict-transport-security"]) add("hsts-missing", "medium", "Strict-Transport-Security header missing");
  if (!h["content-security-policy"]) add("csp-missing", "medium", "Content-Security-Policy header missing");
  if (h["x-content-type-options"]?.toLowerCase() !== "nosniff")
    add("nosniff-missing", "low", "X-Content-Type-Options: nosniff missing");
  const framing = h["x-frame-options"] || /frame-ancestors/i.test(h["content-security-policy"] ?? "");
  if (!framing) add("framing-unprotected", "low", "No X-Frame-Options or CSP frame-ancestors");
  if (h["x-powered-by"]) add("x-powered-by", "info", "X-Powered-By reveals the server stack", h["x-powered-by"]);
  return out;
}

export interface CookieInfo {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None" | undefined;
}

const SESSIONISH = /sess|auth|token|login|sid|xsrf|csrf/i;

export function cookieFindings(url: string, cookies: CookieInfo[]): FindingInput[] {
  const out: FindingInput[] = [];
  for (const c of cookies) {
    const sensitive = SESSIONISH.test(c.name);
    if (!c.secure && url.startsWith("https://"))
      out.push({ category: "security", rule: "security.cookie-not-secure", severity: sensitive ? "medium" : "low", title: `Cookie ${c.name} lacks Secure`, url, selector: c.name });
    if (sensitive && !c.httpOnly && !/xsrf|csrf/i.test(c.name))
      out.push({ category: "security", rule: "security.cookie-not-httponly", severity: "medium", title: `Session cookie ${c.name} lacks HttpOnly`, url, selector: c.name });
    if (c.sameSite === "None" && !c.secure)
      out.push({ category: "security", rule: "security.cookie-samesite-none-insecure", severity: "medium", title: `Cookie ${c.name} is SameSite=None without Secure`, url, selector: c.name });
  }
  return out;
}

/** Fixed list of commonly exposed files. A 200 with matching content is a finding. */
export const EXPOSED_FILE_PROBES: { path: string; looksLike: RegExp; severity: FindingInput["severity"] }[] = [
  { path: "/.env", looksLike: /^[A-Z0-9_]+=.*$/m, severity: "critical" },
  { path: "/.git/config", looksLike: /\[core\]/, severity: "critical" },
  { path: "/wp-config.php.bak", looksLike: /DB_PASSWORD/, severity: "critical" },
  { path: "/debug.log", looksLike: /PHP (Warning|Notice|Fatal)/, severity: "medium" },
];
