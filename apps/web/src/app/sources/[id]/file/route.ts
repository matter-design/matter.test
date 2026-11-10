import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { artefactPath } from "@mattertest/core";
import { sources } from "@mattertest/db";
import { currentUser } from "@/lib/auth";
import { db } from "@/lib/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
  srt: "text/plain; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

/** Download a source's original file (or a Loom source's uploaded transcript). Always as an attachment, never rendered inline. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new Response("Sign in required", { status: 401 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [s] = await db.select({ name: sources.name, fileUri: sources.fileUri }).from(sources).where(eq(sources.id, id));
  if (!s?.fileUri || !s.fileUri.startsWith("sources/")) return new Response("Not found", { status: 404 });
  const ext = s.fileUri.split(".").pop()?.toLowerCase() ?? "";
  try {
    const data = await readFile(artefactPath(s.fileUri));
    const name = s.fileUri.split("/").pop()!.replace(/^[0-9a-f]{16}-/, "");
    return new Response(new Uint8Array(data), {
      headers: {
        "content-type": TYPES[ext] ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "cache-control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
