// debug-log.js
//
// TEMPORARY debug log buffer for diagnosing the discarded/lazy-loaded tab
// marker delay in highlight.js. Gated behind DEBUG_LOG_ENABLED so it costs
// nothing (no buffering, no console spam, no file dump from background.js)
// unless a developer flips it on to investigate marker timing again. Flip to
// `true` locally when needed; leave `false` for normal/shipped use. Remove
// this module entirely once the discarded-tab marker delay is root-caused.
//
// (Not sourced from manifest.json: MV3 has no supported mechanism for
// custom manifest keys - Chrome logs an "Unrecognized manifest key"
// warning in chrome://extensions for any key it doesn't know, even though
// chrome.runtime.getManifest() still returns it. A plain code constant is
// the only warning-free option.)
export const DEBUG_LOG_ENABLED = false;

// Persisted to chrome.storage.session (not just in-memory) so entries
// survive service worker suspension/restart instead of silently starting
// over - a plain in-memory array would otherwise lose everything logged
// before the last restart, and background.js's periodic dump would then
// overwrite the downloaded file with just the post-restart entries,
// discarding everything before it. STORAGE_KEY holds the full cumulative
// log text; every call appends to it, nothing here ever truncates or drops
// earlier entries (aside from the generous DEBUG_LOG_MAX safety cap against
// unbounded growth across a very long-running session).
//
// chrome.storage.session (rather than chrome.storage.local) is deliberate:
// its contents are wiped whenever the extension is reloaded/updated or the
// browser restarts, which is exactly the "per session" scoping we want for
// a temporary diagnostic log - each fresh load starts clean instead of
// accumulating history across unrelated debugging sessions.
const STORAGE_KEY = "highlightDebugLog";
const DEBUG_LOG_MAX = 5000;

let debugLog = [];
let loadPromise = null;

function ensureLoaded() {
  if (!loadPromise) {
    loadPromise = chrome.storage.session
      .get(STORAGE_KEY)
      .then((result) => {
        debugLog = result[STORAGE_KEY] ?? [];
      })
      .catch(() => {
        debugLog = [];
      });
  }
  return loadPromise;
}

export function logEvent(...args) {
  if (!DEBUG_LOG_ENABLED) return;
  const line = `${new Date().toISOString()} ${args.map(String).join(" ")}`;
  console.log("[Highlight]", ...args);
  ensureLoaded().then(() => {
    debugLog.push(line);
    // Trim from the front only once far past the safety cap, and only ever
    // in this rare overflow case - normal operation never drops entries.
    if (debugLog.length > DEBUG_LOG_MAX) {
      debugLog = debugLog.slice(debugLog.length - DEBUG_LOG_MAX);
    }
    chrome.storage.session.set({ [STORAGE_KEY]: debugLog });
  });
}

export async function getDebugLogText() {
  if (!DEBUG_LOG_ENABLED) return "";
  await ensureLoaded();
  return debugLog.join("\n");
}
