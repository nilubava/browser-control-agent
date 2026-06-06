/**
 * scripts/debug-extract.mts — diagnose element collection on a given URL.
 * No API calls. Usage: npx tsx scripts/debug-extract.mts [url]
 */
import { launchBrowser, navigate, observe, closeBrowser } from "../lib/browser";

const url = process.argv[2] ?? "https://www.google.com/travel/flights";

await launchBrowser();
const nav = await navigate(url);
console.log("NAV:", nav.message);

const obs = await observe(1, 25, "debug", "debug", null);
console.log("URL:", obs.url);
console.log("TITLE:", obs.title);
console.log("ELEMENTS DETECTED:", obs.elements.length);
console.log(
  obs.elements
    .slice(0, 30)
    .map((e) => `  [${e.id}] ${e.role} "${e.name?.slice(0, 40)}" <${e.tag}> frame=${e.frameIndex}`)
    .join("\n")
);

await closeBrowser();
process.exit(0);
