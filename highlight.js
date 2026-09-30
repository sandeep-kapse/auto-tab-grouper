// highlight.js
//
// Active Tab + Active Group Highlighter (merged from the standalone
// "Active_(Tab+Group)_Highlight" extension).
//
// 1. Active tab favicon marker: Chrome has no API to color an individual
//    tab directly, so we replace the active tab's favicon with three
//    overlapping red arrow glyphs.
// 2. Active group color highlight: the tab group containing the active
//    tab is colored green, every other group is colored grey.

const MARK_COLOR = "#e60000"; // red
const ACTIVE_TAB_KEY = "faviconHighlightTabId";

// TEMPORARY debug log buffer for diagnosing the discarded/lazy-loaded tab
// marker delay. Bounded ring buffer so it can't grow unbounded. Exposed via
// getDebugLogText() so background.js can periodically dump it to a file.
const DEBUG_LOG_MAX = 500;
const debugLog = [];
function logEvent(...args) {
  const line = `${new Date().toISOString()} ${args.map(String).join(" ")}`;
  debugLog.push(line);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  console.log("[Highlight]", ...args);
}
export function getDebugLogText() {
  return debugLog.join("\n");
}

async function getMarkedTabId() {
  const { [ACTIVE_TAB_KEY]: id } = await chrome.storage.session.get(ACTIVE_TAB_KEY);
  return id ?? null;
}

async function setMarkedTabId(id) {
  if (id === null) {
    await chrome.storage.session.remove(ACTIVE_TAB_KEY);
  } else {
    await chrome.storage.session.set({ [ACTIVE_TAB_KEY]: id });
  }
}

// Runs inside the page. Replaces the page's favicon with the `color`
// arrow marker and watches for the page swapping in a new favicon,
// re-drawing on top of it. Self-contained - no references to outer scope
// allowed since this is serialized and injected via
// chrome.scripting.executeScript.
function markFavicon(color) {
  const NS = "__activeTabHighlight__";

  function draw(link) {
    const raw = link.getAttribute("href") || "/favicon.ico";
    if (link.dataset.markedHref && raw === link.dataset.markedHref) return;
    link.dataset.originalHref = raw;

    const finish = () => {
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");

      const glyph = "\u25B6";
      ctx.font = `bold ${size}px sans-serif`;
      const glyphWidth = ctx.measureText(glyph).width;

      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const step = glyphWidth * 0.35;
      const totalWidth = glyphWidth + step * 2;
      let x = (size - totalWidth) / 2;
      for (let i = 0; i < 3; i++) {
        ctx.fillText(glyph, x, size / 2 + 1);
        x += step;
      }

      const dataUrl = canvas.toDataURL("image/png");
      link.dataset.markedHref = dataUrl;
      link.href = dataUrl;
    };

    finish();
  }

  function getIconLinks() {
    let links = Array.from(document.querySelectorAll("link[rel~='icon']"));
    if (links.length === 0) {
      const link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
      links = [link];
    }
    return links;
  }

  function attach(head) {
    getIconLinks().forEach(draw);
    if (window[NS]) window[NS].disconnect();
    const observer = new MutationObserver(() => getIconLinks().forEach(draw));
    observer.observe(head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"]
    });
    window[NS] = observer;
  }

  // Very early in a fresh navigation (e.g. a discarded/lazy-loaded tab just
  // starting to reload), document.head can still be null. Injecting at that
  // instant used to throw inside the page (observer.observe(null, ...)),
  // silently - a thrown error inside an injected func does not reject the
  // outer executeScript() promise - so the marker was silently lost and
  // only ever applied later via the "complete" re-run. Wait for <head> to
  // exist instead of assuming it's there.
  if (document.head) {
    attach(document.head);
  } else {
    const headWatcher = new MutationObserver(() => {
      if (document.head) {
        headWatcher.disconnect();
        attach(document.head);
      }
    });
    headWatcher.observe(document.documentElement || document, { childList: true, subtree: true });
  }
}

// Runs inside the page. Reverses markFavicon().
function unmarkFavicon() {
  const NS = "__activeTabHighlight__";
  if (window[NS]) {
    window[NS].disconnect();
    delete window[NS];
  }
  document.querySelectorAll("link[rel~='icon']").forEach((link) => {
    if (link.dataset.originalHref !== undefined) {
      link.href = link.dataset.originalHref;
      delete link.dataset.originalHref;
      delete link.dataset.markedHref;
    }
  });
}

// While a tab is mid-navigation (e.g. right after activation, before the
// new document/frame exists yet - such as an initial about:blank), script
// injection can transiently fail even though the tab isn't a restricted
// page. A few quick retries let the marker land as soon as the tab has a
// document to inject into, rather than waiting all the way until the page
// reaches "complete" (the mutation observer set up by markFavicon then
// keeps it in sync with whatever favicon the page swaps in as it loads).
async function applyMark(tabId, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: markFavicon, args: [MARK_COLOR] });
      return;
    } catch (e) {
      logEvent(`applyMark attempt ${i + 1}/${attempts} failed for tab ${tabId}:`, e.message);
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      // Last attempt failing is fine - could be a genuinely restricted page
      // (chrome://, Web Store, etc.); onUpdated's "complete" handler will
      // also retry once the page finishes loading.
    }
  }
}

async function applyUnmark(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: unmarkFavicon });
  } catch (e) {
    // Tab closed or restricted - safe to ignore.
  }
}

// Recompute the full set of group colors fresh on every tab activation:
// the active tab's group goes green, every other group goes grey.
async function updateGroupColors(tab) {
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId });

    for (const group of groups) {
      const desiredColor = group.id === tab.groupId ? "green" : "grey";
      if (group.color === desiredColor) continue;

      let attempts = 0;
      while (attempts < 3) {
        try {
          await chrome.tabGroups.update(group.id, { color: desiredColor });
          break;
        } catch (e) {
          attempts++;
          if (attempts < 3) {
            await new Promise((resolve) => setTimeout(resolve, 150));
          } else {
            console.warn(`[Highlight] Update group ${group.id} failed after retries:`, e.message);
          }
        }
      }
    }
  } catch (err) {
    console.error("[Highlight] Group highlight error:", err.message);
  }
}

// In-memory mirror of "the tab that should currently be highlighted",
// updated synchronously the instant a tab is activated. This is the single
// source of truth for every check below. We deliberately do NOT serialize
// activations behind one another (a strict queue backs up under load, e.g.
// right after a browser restart when many tabs are competing for CPU and
// each scripting call gets slower, which can stall visible highlighting
// indefinitely). Instead, every async step re-checks this value after each
// await and self-corrects if it's gone stale, so correctness never depends
// on which of two concurrent activations happens to finish first.
let currentActiveTabId = null;

async function highlightActiveTab(tabId) {
  currentActiveTabId = tabId;
  logEvent(`onActivated tab ${tabId}`);

  // 1) Group color first: this is a plain tab-group property update, not
  // dependent on page content/load state, so it applies instantly and
  // reliably regardless of whether the tab has finished loading.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (currentActiveTabId !== tabId) return; // superseded already
    await updateGroupColors(tab);
  } catch (err) {
    if (!/No tab with id/.test(err.message)) {
      console.error("[Highlight] Group highlight error:", err.message);
    }
  }

  // 2) Favicon marker second: this depends on injecting into the page, so
  // it's slower and can fail while the page is still loading. `applyMark`
  // swallows injection errors for restricted pages; `onUpdated` below
  // re-applies it once the page finishes loading.
  await applyMark(tabId);

  if (currentActiveTabId !== tabId) {
    // A newer activation happened while applyMark() was in flight. Undo
    // immediately instead of leaving a stale marker behind - we can't rely
    // on the newer task's unmark call having "already" run, since ordering
    // between concurrent tasks isn't guaranteed.
    applyUnmark(tabId);
    return;
  }

  // Still current: safe to unmark whatever was previously marked. Read the
  // previous marked tab from storage rather than an in-memory variable -
  // `chrome.storage.session` survives service worker suspension (e.g. after
  // the browser sits idle and Chrome tears down the worker), so this always
  // finds the tab that actually still has the marker applied, even on a
  // freshly restarted worker with no in-memory history.
  const prevTabId = await getMarkedTabId();
  if (currentActiveTabId !== tabId) return; // superseded while reading storage
  if (prevTabId !== null && prevTabId !== tabId) {
    applyUnmark(prevTabId);
  }

  await setMarkedTabId(tabId);
}

export function initHighlight() {
  // Seed from storage in case the service worker was restarted; doesn't
  // block anything, just avoids losing track of the marked tab for the
  // `onUpdated` reload-remark filter below.
  getMarkedTabId().then((id) => {
    if (currentActiveTabId === null) currentActiveTabId = id;
  });

  chrome.tabs.onActivated.addListener((activeInfo) => {
    highlightActiveTab(activeInfo.tabId);
  });

  // A page reload/navigation - including a discarded/lazy-loaded tab
  // finally starting to load when you switch to it - gives the tab a fresh
  // JS context, wiping the marker and observer we injected. Re-apply on
  // every relevant update while it's still the active tab, not just once
  // it reaches "complete": a discarded tab goes discarded -> loading ->
  // complete, and injection may keep failing (no document yet) through
  // several of those steps, especially on a slow restart with many tabs
  // competing to load. Retrying on each update event - "loading" included
  // - means the marker lands the moment a document actually exists,
  // instead of waiting for the whole page to finish loading. `applyMark`
  // is cheap to call repeatedly: it no-ops the redraw once the favicon it
  // set is already in place. The cheap `currentActiveTabId` check filters
  // out the (usually many) unrelated tabs updating at the same time with
  // zero async cost, so this never queues work for tabs you're not on.
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (tabId !== currentActiveTabId) return;
    if (!changeInfo.status && changeInfo.discarded === undefined) return;
    logEvent(`onUpdated tab ${tabId}`, JSON.stringify(changeInfo));
    await applyMark(tabId);
    if (currentActiveTabId !== tabId) {
      applyUnmark(tabId);
    }
  });
}
