import { acceptVisualChange } from "@/app/actions";

/** Approved / now / diff thumbnails for a visual change, with an approve button. */
export function VisualChange({ findingId, evidence }: { findingId: string; evidence: Record<string, unknown> | null }) {
  const ev = (evidence ?? {}) as { baselineUri?: string; currentUri?: string; diffUri?: string };
  const img = (uri: string | undefined, label: string) =>
    uri ? (
      <a href={`/artefacts/${uri}`} target="_blank" rel="noreferrer" className="shot">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/artefacts/${uri}`} alt={`${label} screenshot`} loading="lazy" />
        <span>{label}</span>
      </a>
    ) : null;
  return (
    <div className="visual-change">
      <div className="shots">{img(ev.baselineUri, "Approved")}{img(ev.currentUri, "Now")}{img(ev.diffUri, "Difference")}</div>
      {ev.currentUri && (
        <form action={acceptVisualChange}>
          <input type="hidden" name="findingId" value={findingId} />
          <button type="submit" className="btn btn-secondary">Approve change</button>
        </form>
      )}
    </div>
  );
}
