/** Minimal robots.txt parser: Disallow/Allow for our user agent or *, longest match wins. */
export interface RobotsRules {
  isAllowed(path: string): boolean;
  sitemaps: string[];
}

export function parseRobots(txt: string, userAgent = "MatterTestBot"): RobotsRules {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  const sitemaps: string[] = [];
  let current: (typeof groups)[number] | undefined;
  let lastWasAgent = false;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "sitemap") {
      sitemaps.push(value);
      continue;
    }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "disallow" && value) current.rules.push({ allow: false, path: value });
    if (key === "allow" && value) current.rules.push({ allow: true, path: value });
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);

  const matches = (pattern: string, path: string) => {
    const re = new RegExp(
      "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"),
    );
    return re.test(path);
  };

  return {
    sitemaps,
    isAllowed(path: string) {
      let best: { allow: boolean; len: number } | undefined;
      for (const r of rules) {
        if (matches(r.path, path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)))
          best = { allow: r.allow, len: r.path.length };
      }
      return best ? best.allow : true;
    },
  };
}
