/**
 * scripts/debug-combobox.mts — verify the observe() pipeline surfaces
 * dropdown options after the agent clicks a custom combobox.
 * No API calls.
 */
import {
  launchBrowser, navigate, observe, clickElement, closeBrowser,
} from "../lib/browser";

await launchBrowser();
await navigate("https://www.google.com/travel/flights");

// First observation — find the trip-type combobox.
const obs1 = await observe(1, 25, "debug", "debug", null);
const combo = obs1.elements.find(
  (e) => e.role === "combobox" && /round trip|one way/i.test(e.name)
);
console.log("Trip-type combobox:", combo ? `#${combo.id} "${combo.name}"` : "NOT FOUND");
if (!combo) { await closeBrowser(); process.exit(1); }

// Click it.
const click = await clickElement(combo.id);
console.log("Click:", click.message);

// Re-observe — do the option items now appear as marked elements?
const obs2 = await observe(2, 25, "debug", "debug", click);
const options = obs2.elements.filter(
  (e) => e.role === "option" || /one way|round trip|multi-city/i.test(e.name)
);
console.log("OPTION-LIKE ELEMENTS AFTER CLICK:", options.length);
console.log(options.map((e) => `  [${e.id}] ${e.role} "${e.name}"`).join("\n"));

await closeBrowser();
process.exit(0);
