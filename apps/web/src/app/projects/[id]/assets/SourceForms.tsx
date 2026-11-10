"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { addConfluencePage, addLoomSource, attachTranscript, uploadSource, type FormState } from "./actions";

function Message({ state }: { state: FormState }) {
  if (state.error) return <p className="error" role="alert">{state.error}</p>;
  if (state.ok) return <p className="banner banner-good" role="status" style={{ margin: 0 }}>{state.ok}</p>;
  return null;
}

/** Upload a document or transcript, or add a Loom link or a Confluence page. */
export function AddSource({ projectId }: { projectId: string }) {
  const [up, upload, uploading] = useActionState(uploadSource, {});
  const [loom, addLoom, adding] = useActionState(addLoomSource, {});
  const [conf, addConf, reading] = useActionState(addConfluencePage, {});
  const fileForm = useRef<HTMLFormElement>(null);
  const loomForm = useRef<HTMLFormElement>(null);
  const confForm = useRef<HTMLFormElement>(null);
  useEffect(() => void (up.ok && fileForm.current?.reset()), [up]);
  useEffect(() => void (loom.ok && loomForm.current?.reset()), [loom]);
  useEffect(() => void (conf.ok && confForm.current?.reset()), [conf]);

  return (
    <div className="dropzone">
      <form ref={fileForm} action={upload} className="stack">
        <input type="hidden" name="projectId" value={projectId} />
        <div className="field">
          <label htmlFor="source-file">Add a source</label>
          <span className="hint small">PDF, Word (.docx) or Markdown, or a transcript (.vtt, .srt, .txt). Up to 25 MB.</span>
          <input id="source-file" name="file" type="file" required accept=".pdf,.docx,.md,.markdown,.vtt,.srt,.txt" />
        </div>
        <button type="submit" className="btn btn-outline btn-sm" disabled={uploading} style={{ alignSelf: "flex-start" }}>{uploading ? "Uploading…" : "Upload"}</button>
        <Message state={up} />
      </form>
      <form ref={loomForm} action={addLoom} className="stack" style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="field">
          <label htmlFor="loom-link">Or a Loom video</label>
          <span className="hint small">Share link. Public videos are read from Loom; for workspace-only ones you&apos;ll be asked for the transcript file.</span>
          <input id="loom-link" name="link" type="url" className="input" required placeholder="https://www.loom.com/share/…" />
        </div>
        <button type="submit" className="btn btn-outline btn-sm" disabled={adding} style={{ alignSelf: "flex-start" }}>{adding ? "Adding…" : "Add video"}</button>
        <Message state={loom} />
      </form>
      <form ref={confForm} action={addConf} className="stack" style={{ paddingTop: 10, borderTop: "1px solid var(--border)" }}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="field">
          <label htmlFor="confluence-link">Or a Confluence page</label>
          <span className="hint small">Page link. It&apos;s read with the team&apos;s Confluence account, so that account needs access to the space.</span>
          <input id="confluence-link" name="link" type="url" className="input" required placeholder="https://yoursite.atlassian.net/wiki/spaces/…/pages/…" />
        </div>
        <label className="row small" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" name="includeChildren" style={{ width: 18, height: 18, margin: 0 }} />
          Include child pages (up to 50, each read as its own source)
        </label>
        <button type="submit" className="btn btn-outline btn-sm" disabled={reading} style={{ alignSelf: "flex-start" }}>{reading ? "Adding…" : "Add page"}</button>
        <Message state={conf} />
      </form>
    </div>
  );
}

/** For a Loom source whose transcript couldn't be read: attach the downloaded transcript. */
export function AttachTranscript({ sourceId }: { sourceId: string }) {
  const [state, action, pending] = useActionState(attachTranscript, {});
  return (
    <form action={action} className="stack" style={{ gap: 8, marginTop: 4 }}>
      <input type="hidden" name="sourceId" value={sourceId} />
      <label htmlFor={`tx-${sourceId}`} className="small" style={{ fontWeight: 600 }}>Upload the transcript (in Loom: ⋯ › Download › Transcript)</label>
      <input id={`tx-${sourceId}`} name="file" type="file" required accept=".vtt,.srt,.txt" style={{ font: "inherit", fontSize: 13, maxWidth: "100%" }} />
      <button type="submit" className="btn btn-outline btn-sm" disabled={pending} style={{ alignSelf: "flex-start" }}>{pending ? "Uploading…" : "Attach transcript"}</button>
      <Message state={state} />
    </form>
  );
}

/** Refresh the page every few seconds while an ingest or plan run is in flight. */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}
