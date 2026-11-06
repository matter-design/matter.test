import type { Browser } from "playwright";
import type { ReportModel } from "./model";
import { renderReportHtml } from "./html";

/**
 * Print the report to an A4 PDF with Chromium. The browser is passed in so the worker
 * and CLI can reuse the one they already have open.
 */
export async function renderReportPdf(browser: Browser, model: ReportModel): Promise<Buffer> {
  const html = renderReportHtml(model);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    // Only the client's logo may load from outside; give it a few seconds and carry on without it.
    await page.setContent(html, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
    const title = `${model.input.client.name} · Website health check`;
    return await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: `<div style="width:100%;font:7.5pt -apple-system,Segoe UI,Arial,sans-serif;color:#98a2b3;padding:0 16mm;display:flex;justify-content:space-between">
        <span>${title.replace(/[<>&]/g, "")}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
    });
  } finally {
    await context.close();
  }
}
