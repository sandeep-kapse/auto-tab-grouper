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

  getIconLinks().forEach(draw);

  if (window[NS]) window[NS].disconnect();
  const observer = new MutationObserver(() => getIconLinks().forEach(draw));
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"]
  });
  window[NS] = observer;
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

async function applyMark(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: markFavicon, args: [MARK_COLOR] });
  } catch (e) {
    // Restricted page (chrome://, Web Store, etc.) - nothing we can do.
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

export function initHighlight() {
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const prevTabId = await getMarkedTabId();
    if (prevTabId !== null && prevTabId !== activeInfo.tabId) {
      await applyUnmark(prevTabId);
    }
    await applyMark(activeInfo.tabId);
    await setMarkedTabId(activeInfo.tabId);

    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      await updateGroupColors(tab);
    } catch (err) {
      if (!/No tab with id/.test(err.message)) {
        console.error("[Highlight] Activation handler error:", err.message);
      }
    }
  });

  // A page reload/navigation gives the tab a fresh JS context, wiping the
  // marker and observer we injected. Re-apply once it finishes loading, if
  // it's still the active tab.
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== "complete") return;
    const markedTabId = await getMarkedTabId();
    if (markedTabId === tabId) {
      await applyMark(tabId);
    }
  });
}
