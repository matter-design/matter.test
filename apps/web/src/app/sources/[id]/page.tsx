import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, inArray } from "drizzle-orm";
import { loomLinkAt } from "@mattertest/core";
import { requirements, sourceChunks, sources } from "@mattertest/db";
import { Shell } from "@/components/Shell";
import { sourceTitle } from "@/lib/assets";
import { latestSiteCheck, projectWithClient } from "@/lib/queries";
import { db } from "@/lib/server";
import { SOURCE_STATUS_LABEL, SOURCE_TYPE_LABEL, clock, dateTime, plural } from "@/lib/format";

export const dynamic = "force-dynamic";

/** A source, passage by passage. Trace links land here with the cited passages highlighted (?hl=chunkId,chunkId). */
export default async function SourceView({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ hl?: string }> }) {
  const { id } = await params;
  const { hl } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [source] = await db.select().from(sources).where(eq(sources.id, id));
  if (!source) notFound();
  const row = await projectWithClient(source.projectId);
  if (!row) notFound();
  const { project, client } = row;
  const [chunks, reqs, latest] = await Promise.all([
    db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, id)).orderBy(asc(sourceChunks.position)),
    db.select({ id: requirements.id, key: requirements.key, title: requirements.title, chunks: requirements.sourceChunkIds, state: requirements.reviewState }).from(requirements).where(inArray(requirements.sourceId, [id])),
    latestSiteCheck(source.projectId),
  ]);
  const highlight = new Set((hl ?? "").split(",").filter(Boolean));
  const reqsAt = (chunkId: string) => reqs.filter((r) => r.chunks.includes(chunkId) && r.state !== "superseded");
  const m = source.meta;

  return (
    <Shell active="assets" project={{ id: project.id, name: project.name, client: client.name, platform: project.platform, latestRunId: latest?.id }}>
      <div className="page-head">
        <div>
          <span className="crumbs"><Link href={`/projects/${project.id}`}>{client.name}</Link> / <Link href={`/projects/${project.id}/assets`}>Test assets</Link> / Source</span>
          <div className="title-row">
            <h1 style={{ overflowWrap: "anywhere" }}>{sourceTitle(source)}</h1>
            <span className={`pill status-${source.status}`}>{SOURCE_STATUS_LABEL[source.status] ?? source.status}</span>
          </div>
          <span className="muted">
            {[SOURCE_TYPE_LABEL[source.type] ?? source.type, source.version > 1 ? `version ${source.version}` : null, m.confluence ? `Confluence version ${m.confluence.version}` : null, m.pages ? plural(m.pages, "page") : null, m.durationSec ? clock(m.durationSec) : null, m.owner ? `by ${m.owner}` : null, plural(chunks.length, "passage"), `added ${dateTime(source.createdAt)}${source.createdBy ? ` by ${source.createdBy}` : ""}`].filter(Boolean).join(" · ")}
          </span>
        </div>
        <div className="row">
          {source.type === "loom" && source.uri && <a className="btn btn-outline" href={source.uri} target="_blank" rel="noreferrer">Open in Loom</a>}
          {source.type === "confluence" && source.uri && <a className="btn btn-outline" href={m.confluence?.webUrl ?? source.uri} target="_blank" rel="noreferrer">Open in Confluence</a>}
          {source.fileUri && <a className="btn btn-outline" href={`/sources/${source.id}/file`}>Download {source.type === "loom" ? "transcript" : source.type === "confluence" ? "page as read (HTML)" : "original"}</a>}
        </div>
      </div>

      {source.error && <p className={source.status === "failed" ? "error" : "banner"}>{source.error}</p>}
      {!chunks.length ? (
        <div className="empty">No passages yet.</div>
      ) : (
        <section className="panel" style={{ padding: 0, gap: 0 }} aria-label="Passages">
          {chunks.map((c) => {
            const used = reqsAt(c.id);
            return (
              <article key={c.id} id={`chunk-${c.id}`} className={`chunk${highlight.has(c.id) ? " chunk-hl" : ""}`}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="small" style={{ fontWeight: 600 }}>{c.sectionPath ?? `Passage ${c.position + 1}`}{c.locator.page && !c.sectionPath?.startsWith("Page") ? ` · p. ${c.locator.page}` : ""}</span>
                  {source.uri && c.locator.startSec !== undefined && <a className="small" href={loomLinkAt(source.uri, c.locator.startSec)} target="_blank" rel="noreferrer">Watch at {clock(c.locator.startSec)}</a>}
                </div>
                <p className="chunk-text">{c.text}</p>
                {used.length > 0 && (
                  <span className="small muted">
                    Used by{" "}
                    {used.map((r, i) => (
                      <span key={r.id}>{i > 0 && ", "}<Link href={`/projects/${project.id}/review?item=req:${r.id}`}>{r.key}</Link></span>
                    ))}
                  </span>
                )}
              </article>
            );
          })}
        </section>
      )}
    </Shell>
  );
}
