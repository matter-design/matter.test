import { z } from "zod";
import { chromium } from "playwright";
import { buildReport, renderReportPdf } from "@mattertest/report";
import { currentUser } from "@/lib/auth";
import { loadReportInput } from "@/lib/report";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /runs/:id/report → client PDF for a finished site-check run. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new Response("Sign in required", { status: 401 });
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) return new Response("Not found", { status: 404 });

  const found = await loadReportInput(id);
  if (!found.ok) return new Response(found.message, { status: found.status, headers: { "content-type": "text/plain; charset=utf-8" } });

  const browser = await chromium.launch();
  try {
    const pdf = await renderReportPdf(browser, buildReport(found.input));
    return new Response(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${found.fileName}"`,
        "cache-control": "no-store",
      },
    });
  } finally {
    await browser.close();
  }
}
