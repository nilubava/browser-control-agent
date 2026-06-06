/**
 * lib/browser.ts
 *
 * Playwright wrapper + the observe() pipeline.
 *
 * Key responsibilities:
 *  1. Browser lifecycle  — singleton launch/close, one context per session.
 *  2. Navigation helpers — navigate(), goBack(), scroll(), key().
 *  3. observe()          — the core perception step:
 *       a. Dismiss modals / cookie banners cheaply before snapshotting.
 *       b. Walk a11y tree across all frames to collect interactive elements.
 *       c. Get bounding boxes and annotate the screenshot with numbered marks.
 *       d. Return an Observation bundle the agent loop feeds to the model.
 *
 * Element IDs are stable only within a single turn; re-extracted every observe().
 */

import { chromium, Browser, BrowserContext, Page, ElementHandle, Frame } from "playwright";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PageElement {
  id: number;
  role: string;
  name: string;
  tag: string;
  type?: string;          // input type attribute if applicable
  value?: string;         // current value
  placeholder?: string;
  enabled: boolean;
  visible: boolean;
  frameIndex: number;     // 0 = main frame, 1+ = iframes in order
  frameUrl: string;
  selector: string;       // unique CSS/XPath selector for Playwright
}

export interface Observation {
  url: string;
  title: string;
  step: number;
  maxSteps: number;
  screenshotBase64: string;   // annotated PNG, numbered marks
  elements: PageElement[];
  openDialogs: boolean;
  numTabs: number;
  lastActionResult: ActionResult | null;
  goal: string;
  successCriteria: string;
  consoleErrors: string[];
  // Detected page-level problems the model should act on immediately
  pageWarnings: string[];
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;
const _consoleErrors: string[] = [];

export async function launchBrowser(): Promise<Page> {
  if (_page) return _page;

  const headless = process.env.BROWSER_HEADLESS === "true";

  _browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled", // reduce bot detection
    ],
  });

  _context = await _browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US",
  });

  // esbuild/tsx compiles with `keepNames`, which injects `__name()` helper calls
  // into every function — including the ones we serialize into page.evaluate().
  // That helper isn't defined in the browser, so evaluated code throws
  // "ReferenceError: __name is not defined" and element extraction silently
  // yields nothing. Shim it in every page/frame. Passed as a STRING so esbuild
  // can't instrument the shim itself (which would re-introduce the same error).
  await _context.addInitScript({
    content: "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
  });

  _page = await _context.newPage();

  // Collect console errors for the observation bundle
  _page.on("console", (msg) => {
    if (msg.type() === "error") {
      _consoleErrors.push(msg.text().slice(0, 200));
      if (_consoleErrors.length > 20) _consoleErrors.shift();
    }
  });

  return _page;
}

export async function closeBrowser(): Promise<void> {
  await _browser?.close();
  _browser = null;
  _context = null;
  _page = null;
  _consoleErrors.length = 0;
}

export function getPage(): Page {
  if (!_page) throw new Error("Browser not launched. Call launchBrowser() first.");
  return _page;
}

// ---------------------------------------------------------------------------
// Navigation helpers
// ---------------------------------------------------------------------------

export async function navigate(url: string): Promise<ActionResult> {
  const page = getPage();
  try {
    // Ensure absolute URL
    const fullUrl = url.startsWith("http") ? url : `https://${url}`;
    await page.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForSettle(page);
    return { ok: true, message: `Navigated to ${fullUrl}` };
  } catch (err) {
    return { ok: false, message: `Navigation failed: ${errorMessage(err)}` };
  }
}

export async function goBack(): Promise<ActionResult> {
  const page = getPage();
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
    await waitForSettle(page);
    return { ok: true, message: "Went back" };
  } catch (err) {
    return { ok: false, message: `Go back failed: ${errorMessage(err)}` };
  }
}

export async function pressKey(keys: string): Promise<ActionResult> {
  const page = getPage();
  try {
    await page.keyboard.press(keys);
    await waitForSettle(page);
    return { ok: true, message: `Pressed key: ${keys}` };
  } catch (err) {
    return { ok: false, message: `Key press failed: ${errorMessage(err)}` };
  }
}

export async function scroll(
  direction: "up" | "down" | "left" | "right",
  elementId?: number
): Promise<ActionResult> {
  const page = getPage();
  try {
    const deltaMap = {
      down: [0, 600],
      up: [0, -600],
      left: [-400, 0],
      right: [400, 0],
    };
    const [dx, dy] = deltaMap[direction];

    if (elementId !== undefined) {
      const el = _elementRegistry.get(elementId);
      if (el) {
        const locator = frameForIndex(page, el.frameIndex).locator(el.selector);
        await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        return { ok: true, message: `Scrolled element ${elementId} into view` };
      }
    }

    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(400);
    return { ok: true, message: `Scrolled ${direction}` };
  } catch (err) {
    return { ok: false, message: `Scroll failed: ${errorMessage(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Element registry — populated by observe(), consumed by click/type/select
// ---------------------------------------------------------------------------

const _elementRegistry = new Map<number, PageElement>();

export function getElement(id: number): PageElement | undefined {
  return _elementRegistry.get(id);
}

// ---------------------------------------------------------------------------
// Click / type / select — operate via the registry
// ---------------------------------------------------------------------------

export async function clickElement(elementId: number): Promise<ActionResult> {
  const page = getPage();
  const el = _elementRegistry.get(elementId);
  if (!el) return { ok: false, message: `Element ${elementId} not found in registry (re-observe?)` };

  try {
    const frame = frameForIndex(page, el.frameIndex);
    const locator = frame.locator(el.selector);
    await locator.waitFor({ state: "visible", timeout: 8_000 });
    await locator.click({ timeout: 8_000 });
    await waitForSettle(page);
    return { ok: true, message: `Clicked element ${elementId} (${el.name || el.role})` };
  } catch (err) {
    return { ok: false, message: `Click failed on element ${elementId}: ${errorMessage(err)}` };
  }
}

export async function typeIntoElement(
  elementId: number,
  text: string,
  submit = false
): Promise<ActionResult> {
  const page = getPage();
  const el = _elementRegistry.get(elementId);
  if (!el) return { ok: false, message: `Element ${elementId} not found in registry` };

  try {
    const frame = frameForIndex(page, el.frameIndex);
    const locator = frame.locator(el.selector);
    await locator.waitFor({ state: "visible", timeout: 8_000 });
    await locator.click({ timeout: 5_000 });
    await locator.fill(text, { timeout: 8_000 });
    if (submit) {
      await page.keyboard.press("Enter");
      await waitForSettle(page);
    }
    return { ok: true, message: `Typed "${text}" into element ${elementId}${submit ? " + Enter" : ""}` };
  } catch (err) {
    return { ok: false, message: `Type failed on element ${elementId}: ${errorMessage(err)}` };
  }
}

export async function selectOption(
  elementId: number,
  value: string
): Promise<ActionResult> {
  const page = getPage();
  const el = _elementRegistry.get(elementId);
  if (!el) return { ok: false, message: `Element ${elementId} not found in registry` };

  try {
    const frame = frameForIndex(page, el.frameIndex);
    const locator = frame.locator(el.selector);
    // Try by value, then by label
    await locator.selectOption(value, { timeout: 8_000 });
    return { ok: true, message: `Selected option "${value}" in element ${elementId}` };
  } catch {
    try {
      const frame = frameForIndex(page, el.frameIndex);
      await frame.locator(el.selector).selectOption({ label: value }, { timeout: 5_000 });
      return { ok: true, message: `Selected label "${value}" in element ${elementId}` };
    } catch (err2) {
      return { ok: false, message: `Select failed: ${errorMessage(err2)}` };
    }
  }
}

export async function extractText(query: string): Promise<ActionResult> {
  const page = getPage();
  try {
    const text = await page.evaluate(() => document.body.innerText);
    // Return a trimmed excerpt relevant to the query (model will parse it)
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const relevant = lines.slice(0, 120).join("\n");
    return { ok: true, message: `Page text (for "${query}"):\n${relevant}` };
  } catch (err) {
    return { ok: false, message: `Extract failed: ${errorMessage(err)}` };
  }
}

/**
 * Raw visible text of the current page, trimmed. Used by the verify step to
 * ground the completion check in actual on-page content (not just the screenshot).
 */
export async function getVisibleText(maxChars = 4_000): Promise<string> {
  const page = getPage();
  try {
    const text = await page.evaluate(() => document.body.innerText);
    return text.replace(/\n{3,}/g, "\n\n").trim().slice(0, maxChars);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// observe() — the heart of the perception pipeline
// ---------------------------------------------------------------------------

export async function observe(
  step: number,
  maxSteps: number,
  goal: string,
  successCriteria: string,
  lastActionResult: ActionResult | null
): Promise<Observation> {
  const page = getPage();

  // 1. Wait for any in-flight navigation/network to settle
  await waitForSettle(page);

  // 2. Dismiss cheap-to-dismiss overlays before snapshotting
  await dismissOverlays(page);

  // 3. Collect interactive elements across all frames
  const elements = await collectElements(page);

  // 4. Populate the registry (cleared each turn)
  _elementRegistry.clear();
  for (const el of elements) {
    _elementRegistry.set(el.id, el);
  }

  // 5. Annotate screenshot with numbered marks
  const screenshotBase64 = await annotateScreenshot(page, elements);

  // 6. Check for open dialogs
  const openDialogs = await page.evaluate(() => {
    return !!document.querySelector(
      'dialog[open], [role="dialog"], [role="alertdialog"]'
    );
  });

  const numTabs = _context?.pages().length ?? 1;

  // Drain and snapshot console errors
  const consoleErrors = [..._consoleErrors];

  const url = page.url();
  const title = await page.title();

  // 7. Detect page-level problems and surface them as explicit warnings.
  //    The model may not recognise these from the screenshot alone, but with a
  //    clear text signal it can immediately navigate elsewhere or give_up.
  const pageWarnings = detectPageWarnings(url, title, elements.length);

  return {
    url,
    title,
    step,
    maxSteps,
    screenshotBase64,
    elements,
    openDialogs,
    numTabs,
    lastActionResult,
    goal,
    successCriteria,
    consoleErrors,
    pageWarnings,
  };
}

// ---------------------------------------------------------------------------
// Page-level problem detection
// ---------------------------------------------------------------------------

// Patterns that indicate bot/access blocks
const BLOCK_TITLE_PATTERNS = [
  /access denied/i,
  /access to this page has been denied/i,
  /403 forbidden/i,
  /cloudflare/i,
  /just a moment/i,         // Cloudflare "checking your browser"
  /are you a robot/i,
  /captcha/i,
  /blocked/i,
  /security check/i,
  /ddos protection/i,
];

const BLOCK_URL_PATTERNS = [
  /chrome-error:\/\//,      // failed navigation
  /\/blocked/i,
  /\/denied/i,
  /\/captcha/i,
];

const ERROR_TITLE_PATTERNS = [
  /\b404\b/,
  /not found/i,
  /\b500\b/,
  /internal server error/i,
  /service unavailable/i,
  /\b503\b/,
  /page not found/i,
  /error/i,
];

function detectPageWarnings(url: string, title: string, elementCount: number): string[] {
  const warnings: string[] = [];

  // Bot / access block
  const isBlockedByTitle = BLOCK_TITLE_PATTERNS.some((p) => p.test(title));
  const isBlockedByUrl = BLOCK_URL_PATTERNS.some((p) => p.test(url));
  if (isBlockedByTitle || isBlockedByUrl) {
    warnings.push(
      `BOT/ACCESS BLOCK DETECTED: The site is blocking automated access ` +
      `(title: "${title}", url: "${url}"). ` +
      `This site cannot be used. Navigate to an alternative site to complete the goal, ` +
      `or call give_up() explaining the block.`
    );
  }

  // Zero elements on a real page (not a blank start page) — likely blocked or broken
  if (
    elementCount === 0 &&
    url !== "about:blank" &&
    !url.startsWith("chrome-error://") &&
    !isBlockedByTitle  // already warned above
  ) {
    warnings.push(
      `NO INTERACTIVE ELEMENTS DETECTED on ${url}. ` +
      `The page may be blocked, still loading, or heavily JavaScript-dependent. ` +
      `Try: wait → re-observe, or navigate to an alternative site.`
    );
  }

  // HTTP error pages
  const isErrorPage = ERROR_TITLE_PATTERNS.some((p) => p.test(title));
  if (isErrorPage && !isBlockedByTitle) {
    warnings.push(
      `PAGE ERROR DETECTED: "${title}" at ${url}. ` +
      `The page returned an error. Try navigating to the site's homepage or an alternative URL.`
    );
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Overlay dismissal — cheap heuristic, runs before every observe()
// ---------------------------------------------------------------------------

// Consent/cookie-banner buttons only. These are intentionally specific to
// consent UIs — NOT generic "OK"/"Close" buttons, which often belong to the
// app's own forms and dropdowns. Dismissing those would undo the agent's work.
const DISMISS_SELECTORS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("Accept cookies")',
  'button:has-text("Accept Cookies")',
  'button:has-text("I Accept")',
  'button:has-text("I agree")',
  'button:has-text("Agree")',
  'button:has-text("Got it")',
  'button:has-text("No thanks")',
  '[aria-label="Accept all"]',
  '[aria-label="Consent"]',
];

async function dismissOverlays(page: Page): Promise<void> {
  // IMPORTANT: never press Escape or click generic close buttons here. Many
  // apps (e.g. Google Flights) keep a persistent [role="dialog"] in the DOM,
  // and a blanket Escape would close menus/date-pickers the agent just opened.
  // We only click clearly-labelled consent buttons, and at most one per call.
  for (const sel of DISMISS_SELECTORS) {
    try {
      const el = page.locator(sel).first();
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        await el.click({ timeout: 3_000 });
        await page.waitForTimeout(400);
        return; // dismiss one at a time; observe() will call again if needed
      }
    } catch {
      // ignore — any selector can throw
    }
  }
}

// ---------------------------------------------------------------------------
// A11y element collection — walks main frame + all iframes
// ---------------------------------------------------------------------------

/** Interactive ARIA roles we want to surface to the model */
const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox",
  "listbox", "option", "checkbox", "radio", "switch",
  "menuitem", "menuitemcheckbox", "menuitemradio",
  "spinbutton", "slider", "tab", "treeitem",
  "gridcell",
]);

async function collectElements(page: Page): Promise<PageElement[]> {
  const elements: PageElement[] = [];
  let idCounter = 1;

  const frames: Array<{ frame: Frame; index: number; url: string }> = [
    { frame: page.mainFrame(), index: 0, url: page.url() },
  ];

  // Include child iframes
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    frames.push({ frame, index: frames.length, url: frame.url() });
  }

  for (const { frame, index: frameIndex, url: frameUrl } of frames) {
    try {
      const frameElements = await extractFrameElements(
        frame,
        frameIndex,
        frameUrl,
        idCounter
      );
      elements.push(...frameElements);
      idCounter += frameElements.length;
    } catch {
      // Inaccessible cross-origin frame (or an extraction error in one frame) —
      // skip it rather than failing the whole observation.
    }
  }

  return elements;
}

async function extractFrameElements(
  frame: Frame,
  frameIndex: number,
  frameUrl: string,
  startId: number
): Promise<PageElement[]> {
  // We run this extraction in page context for performance. We stamp each
  // detected element with a unique `data-agent-id` attribute and target it by
  // [data-agent-id="N"] — guaranteed unique, unlike generated CSS paths which
  // collide badly on framework-heavy DOMs (Google Flights, etc.).
  const raw = await frame.evaluate((startId: number) => {
    const results: Array<{
      id: number;
      role: string; name: string; tag: string; type: string;
      value: string; placeholder: string; enabled: boolean;
      rect: { x: number; y: number; width: number; height: number } | null;
      selector: string;
    }> = [];

    const interactiveRoles = new Set([
      "button", "link", "textbox", "searchbox", "combobox",
      "listbox", "option", "checkbox", "radio", "switch",
      "menuitem", "menuitemcheckbox", "menuitemradio",
      "spinbutton", "slider", "tab", "treeitem", "gridcell",
    ]);

    // Clear stamps from a previous observation so old + new ids never collide.
    for (const stamped of Array.from(document.querySelectorAll("[data-agent-id]"))) {
      stamped.removeAttribute("data-agent-id");
    }

    const seen = new WeakSet<Element>();

    function getRole(el: Element): string {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit.toLowerCase();
      const tag = el.tagName.toLowerCase();
      const typeAttr = (el as HTMLInputElement).type?.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        if (typeAttr === "checkbox") return "checkbox";
        if (typeAttr === "radio") return "radio";
        if (typeAttr === "submit" || typeAttr === "button" || typeAttr === "reset") return "button";
        if (typeAttr === "range") return "slider";
        return "textbox";
      }
      // Clickable divs/spans with onclick
      if (el.getAttribute("onclick") || el.getAttribute("tabindex") === "0") return "button";
      return "";
    }

    function getAccessibleName(el: Element): string {
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel) return ariaLabel;
      const labelledById = el.getAttribute("aria-labelledby");
      if (labelledById) {
        const labelEl = document.getElementById(labelledById);
        if (labelEl?.textContent) return labelEl.textContent.trim();
      }
      return (
        (el as HTMLElement).title ||
        (el as HTMLInputElement).placeholder ||
        el.textContent?.trim().slice(0, 80) ||
        ""
      );
    }

    function isVisible(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    }

    // Walk all elements
    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      if (seen.has(el)) continue;
      const role = getRole(el);
      if (!role || !interactiveRoles.has(role)) continue;
      if (!isVisible(el)) continue;
      seen.add(el);

      const id = startId + results.length;
      el.setAttribute("data-agent-id", String(id));

      const rect = el.getBoundingClientRect();
      results.push({
        id,
        role,
        name: getAccessibleName(el),
        tag: el.tagName.toLowerCase(),
        type: (el as HTMLInputElement).type || "",
        value: (el as HTMLInputElement).value || "",
        placeholder: (el as HTMLInputElement).placeholder || "",
        enabled: !(el as HTMLButtonElement).disabled,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        selector: `[data-agent-id="${id}"]`,
      });
    }

    return results;
  }, startId);

  return raw
    .filter((el) => el.rect && el.rect.width > 0 && el.rect.height > 0)
    .map((el) => ({
      id: el.id,
      role: el.role,
      name: el.name,
      tag: el.tag,
      type: el.type || undefined,
      value: el.value || undefined,
      placeholder: el.placeholder || undefined,
      enabled: el.enabled,
      visible: true,
      frameIndex,
      frameUrl,
      selector: el.selector,
    }));
}

// ---------------------------------------------------------------------------
// Screenshot annotation — draw numbered boxes over each element
// ---------------------------------------------------------------------------

async function annotateScreenshot(page: Page, elements: PageElement[]): Promise<string> {
  // 1. Get bounding boxes from the live page for each element
  const boxes = await page.evaluate((selectors: string[]) => {
    return selectors.map((sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      } catch {
        return null;
      }
    });
  }, elements.map((e) => e.selector));

  // 2. Take raw screenshot
  const rawPng = await page.screenshot({ type: "png" });

  // 3. Draw annotations via canvas in a new page (avoids sharp/canvas dependencies)
  const annotated = await annotateWithCanvas(page, rawPng, elements, boxes);

  return annotated.toString("base64");
}

type BBox = { x: number; y: number; w: number; h: number } | null;

async function annotateWithCanvas(
  page: Page,
  rawPng: Buffer,
  elements: PageElement[],
  boxes: BBox[]
): Promise<Buffer> {
  // Encode raw PNG as base64 to pass into the annotation step
  const rawB64 = rawPng.toString("base64");

  // We spin up a temporary about:blank page to use its Canvas API
  const annotPage = await _context!.newPage();
  try {
    const result = await annotPage.evaluate(
      async ({ rawB64, annotations }: {
        rawB64: string;
        annotations: Array<{ id: number; box: BBox }>;
      }) => {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = reject;
          img.src = `data:image/png;base64,${rawB64}`;
        });

        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0);

        const colors = ["#FF3B30", "#FF9500", "#34C759", "#007AFF", "#AF52DE"];
        const fontSize = Math.max(10, Math.min(14, img.width / 100));

        for (const { id, box } of annotations) {
          if (!box || box.w < 2 || box.h < 2) continue;
          const color = colors[(id - 1) % colors.length];

          // Bounding box
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.strokeRect(box.x, box.y, box.w, box.h);

          // Label pill
          const label = String(id);
          ctx.font = `bold ${fontSize}px monospace`;
          const tw = ctx.measureText(label).width;
          const pw = tw + 6;
          const ph = fontSize + 4;
          const px = Math.max(0, box.x);
          const py = Math.max(0, box.y - ph - 2);

          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.roundRect(px, py, pw, ph, 3);
          ctx.fill();

          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(label, px + 3, py + fontSize);
        }

        return canvas.toDataURL("image/png").split(",")[1];
      },
      {
        rawB64,
        annotations: elements.map((el, i) => ({ id: el.id, box: boxes[i] })),
      }
    );

    return Buffer.from(result, "base64");
  } finally {
    await annotPage.close();
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Wait for network idle + no pending navigations, with a short timeout */
async function waitForSettle(page: Page, ms = 2_000): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: ms });
  } catch {
    // domcontentloaded is enough; networkidle can hang on sites with long-poll XHR
  }
}

function frameForIndex(page: Page, frameIndex: number): Frame {
  if (frameIndex === 0) return page.mainFrame();
  const frames = page.frames();
  return frames[frameIndex] ?? page.mainFrame();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
