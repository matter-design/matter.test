/**
 * Download the local embedding model and check it works (`pnpm --filter @mattertest/agent fetch-model`).
 * The worker downloads it on first ingest anyway; this just does it up front.
 */
import { localEmbedder } from "../src/embed";

const t = Date.now();
const e = localEmbedder();
const [a, b, c] = await e.embed([
  "Expired promo codes show an error under the field.",
  "Guest checkout with standard shipping.",
  "A voucher past its end date is refused with a message.",
]);
const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
console.log(`${e.name}: ${a!.length} dimensions in ${((Date.now() - t) / 1000).toFixed(1)} s`);
console.log(`similar sentences ${dot(a!, c!).toFixed(2)}, unrelated ${dot(b!, c!).toFixed(2)}`);
