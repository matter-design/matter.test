"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Platform } from "@mattertest/core";
import { PLATFORM_LABEL, timeAgo } from "@/lib/format";

export interface CardData {
  id: string;
  name: string;
  client: string;
  platform: Platform;
  status: string;
  domain: string | null;
  openFindings: number;
  critical: number;
  high: number;
  health: number | null;
  lastCheck: { status: string; at: string } | null;
}

const STATUSES = ["All", "Active", "Onboarding"] as const;

function lastCheckLine(c: CardData): { text: string; tone: "good" | "bad" | "busy" | "idle" } {
  if (!c.lastCheck) return { text: "No check yet", tone: "idle" };
  const when = timeAgo(new Date(c.lastCheck.at));
  switch (c.lastCheck.status) {
    case "running":
      return { text: "Check running", tone: "busy" };
    case "queued":
      return { text: "Check queued", tone: "busy" };
    case "failed":
      return { text: `Last check failed · ${when}`, tone: "bad" };
    default:
      return { text: `Checked ${when}`, tone: c.critical > 0 ? "bad" : "good" };
  }
}

/** Search and filters run in the browser: the list is small and already loaded. */
export function ProjectsBrowser({ cards }: { cards: CardData[] }) {
  const [q, setQ] = useState("");
  const [platform, setPlatform] = useState<"all" | Platform>("all");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("All");
  const platforms = useMemo(() => [...new Set(cards.map((c) => c.platform))].sort(), [cards]);

  const shown = cards.filter((c) => {
    const text = `${c.name} ${c.client} ${c.domain ?? ""}`.toLowerCase();
    return (
      (!q || text.includes(q.trim().toLowerCase())) &&
      (platform === "all" || c.platform === platform) &&
      (status === "All" || c.status === status.toLowerCase())
    );
  });

  return (
    <>
      <div className="toolbar">
        <label htmlFor="proj-search" className="sr-only">Search projects</label>
        <input id="proj-search" type="search" className="input grow" placeholder="Search projects or clients" value={q} onChange={(e) => setQ(e.target.value)} />
        <label htmlFor="proj-platform" className="sr-only">Platform</label>
        <select id="proj-platform" className="input" value={platform} onChange={(e) => setPlatform(e.target.value as Platform | "all")}>
          <option value="all">All platforms</option>
          {platforms.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
        </select>
        <div role="group" aria-label="Status" className="row" style={{ gap: 6 }}>
          {STATUSES.map((s) => (
            <button key={s} type="button" className="chip" aria-pressed={s === status} onClick={() => setStatus(s)}>{s}</button>
          ))}
        </div>
      </div>

      {shown.length ? (
        <div className="grid">
          {shown.map((c) => {
            const line = lastCheckLine(c);
            return (
              <Link key={c.id} href={`/projects/${c.id}`} className="project-card">
                <div className="project-card-head">
                  <div>
                    <span className="project-card-name">{c.name}</span>
                    <span className="project-card-domain">{[c.client !== c.name ? c.client : null, c.domain].filter(Boolean).join(" · ")}</span>
                  </div>
                  <span className="pill">{PLATFORM_LABEL[c.platform]}</span>
                </div>
                <div className="stats">
                  <div className="stat"><span className="stat-label">Health</span><span className="stat-value">{c.health ?? "—"}</span></div>
                  <div className="stat"><span className="stat-label">Open findings</span><span className="stat-value">{c.lastCheck ? c.openFindings : "—"}</span></div>
                  <div className="stat"><span className="stat-label">Critical · high</span><span className="stat-value">{c.lastCheck ? `${c.critical} · ${c.high}` : "—"}</span></div>
                </div>
                <div className="project-card-foot">
                  <span className={`dot dot-${line.tone}`} suppressHydrationWarning>{line.text}</span>
                  {c.status === "onboarding" && <span className="pill">Onboarding</span>}
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="empty">{cards.length ? "No projects match these filters." : "No projects yet. Use New project to set one up."}</p>
      )}
    </>
  );
}
