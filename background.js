// background.js

import { compileRules, matchCompiledRules } from "./rules.js";
import { planGroupMerges, partitionMovableTabs } from "./groups.js";
import { getSettings } from "./storage.js";
import { initHighlight, getDebugLogText } from "./highlight.js";

// Active tab favicon marker + active group color highlight (merged from the
// standalone "Active_(Tab+Group)_Highlight" extension).
initHighlight();

// --- TEMPORARY debug log dump ---
// Periodically writes highlight.js's in-memory debug log to a fixed file in
// the Downloads folder so it can be inspected without keeping the service
// worker's DevTools console open (which itself can prevent the suspension
// scenarios we're trying to diagnose). Remove once the discarded-tab marker
// delay is root-caused.
const DEBUG_LOG_ALARM = "highlightDebugLogDump";
chrome.alarms.create(DEBUG_LOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DEBUG_LOG_ALARM) return;
  const text = getDebugLogText();
  if (!text) return;
  const dataUrl = `data:text/plain;base64,${btoa(unescape(encodeURIComponent(text)))}`;
  chrome.downloads.download(
    {
      url: dataUrl,
      filename: "auto-tab-grouper-debug.log",
      conflictAction: "overwrite",
      saveAs: false,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error("[Highlight] Debug log dump failed:", chrome.runtime.lastError.message);
      }
    }
  );
});

// --- Custom Logger ---
let debugMode = false;
const logger = {
  log: (...args) => {
    if (debugMode) console.log("[Auto Tab Grouper]", ...args);
  },
  warn: (...args) => {
    if (debugMode) console.warn("[Auto Tab Grouper]", ...args);
  },
  error: (...args) => console.error("[Auto Tab Grouper]", ...args),
};

async function updateDebugState() {
  try {
    const result = await getSettings({ debugModeEnabled: false });
    debugMode = result.debugModeEnabled;
    logger.log("Debug mode is now:", debugMode ? "ENABLED" : "DISABLED");
  } catch (err) {
    logger.error("[updateDebugState] Could not read settings:", err);
  }
}
updateDebugState();

// --- Rule cache ---
// The rule set changes rarely but is consulted once per tab, so it is compiled
// (including user regexes) once and invalidated from the storage listener.
let compiledRules = null;

async function getCompiledRules() {
  if (compiledRules) return compiledRules;
  let domainGroups = {};
  try {
    ({ domainGroups } = await getSettings({ domainGroups: {} }));
  } catch (err) {
    logger.error("[getCompiledRules] Could not read rules:", err);
    return [];
  }
  const { rules, invalid } = compileRules(domainGroups);
  for (const { key, error } of invalid) {
    logger.warn(`[getCompiledRules] Skipping invalid regex '${key}':`, error);
  }
  compiledRules = rules;
  return compiledRules;
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.debugModeEnabled) {
    debugMode = changes.debugModeEnabled.newValue;
    logger.log("Debug mode updated to:", debugMode ? "ENABLED" : "DISABLED");
  }
  if (changes.domainGroups) {
    compiledRules = null;
    logger.log("Rule cache invalidated.");
  }
});

// --- Queue ---
// Tab ids are tracked in a Set because the same tab can be offered by several
// listeners (an update, a window sweep and a manual "Group All") at once.
const tabQueue = [];
const queuedTabIds = new Set();
let isProcessingQueue = false;

function enqueueTab(tabInfo) {
  if (queuedTabIds.has(tabInfo.tabId)) return false;
  queuedTabIds.add(tabInfo.tabId);
  tabQueue.push(tabInfo);
  return true;
}

async function processQueue() {
  if (isProcessingQueue || tabQueue.length === 0) return;
  isProcessingQueue = true;
  logger.log(`[processQueue] Started processing ${tabQueue.length} tabs.`);
  while (tabQueue.length > 0) {
    const tabInfo = tabQueue.shift();
    logger.log("[processQueue] Processing next tab:", tabInfo);
    try {
      await handleTab(tabInfo);
    } catch (error) {
      logger.error(
        `[processQueue] Error processing tab ${tabInfo.tabId}:`,
        error
      );
    } finally {
      queuedTabIds.delete(tabInfo.tabId);
    }
  }
  isProcessingQueue = false;
  logger.log("[processQueue] Finished processing queue.");
}

// --- Grouping ---
const MAX_RETRIES = 4;

// Chrome rejects tab edits while a drag or a window teardown is in flight, and
// only reports it through the message text.
function isTabsLockedError(err) {
  return Boolean(err?.message?.includes("Tabs cannot be edited right now"));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOrLog(err, tabInfo, retryCount, label) {
  if (isTabsLockedError(err) && retryCount < MAX_RETRIES) {
    const wait = 250 * 2 ** retryCount;
    logger.warn(`[handleTab] Tab is locked. Retrying in ${wait}ms...`);
    await delay(wait);
    return handleTab(tabInfo, retryCount + 1);
  }
  logger.error(`[handleTab] ${label}:`, err);
  return undefined;
}

async function handleTab(tabInfo, retryCount = 0) {
  const { tabId } = tabInfo;
  logger.log(
    `[handleTab] Checking Tab ID: ${tabId}, Attempt: ${retryCount + 1}`
  );

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    logger.log(`[handleTab] Tab not found: ${tabId}, likely closed.`);
    return;
  }

  if (tab.pinned) {
    logger.log(`[handleTab] Tab ${tabId} is pinned. Skipping.`);
    return;
  }
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    logger.log(`[handleTab] Tab ${tabId} is already in a group. Skipping.`);
    return;
  }

  const rules = await getCompiledRules();
  const match = matchCompiledRules(tab.url, rules);
  if (!match) return;

  const groupInfo = match.info;
  logger.log(`[handleTab] Matched rule '${match.key}' for ${tab.url}`);

  const targetWindowId = tabInfo.windowId || tab.windowId;
  let groups;
  try {
    groups = await chrome.tabGroups.query({ windowId: targetWindowId });
  } catch (err) {
    logger.error(
      `[handleTab] Failed to query tab groups for window ${targetWindowId}`,
      err
    );
    return;
  }

  const targetGroup = groups.find((g) => g.title === groupInfo.title);

  if (!targetGroup) {
    logger.log(
      `[handleTab] Creating new group in window ${targetWindowId}: ${groupInfo.title}`
    );
    try {
      const newGroupId = await chrome.tabs.group({ tabIds: tab.id });
      await chrome.tabGroups.update(newGroupId, {
        title: groupInfo.title,
        color: groupInfo.color,
      });
      logger.log(`[handleTab] Group created with ID: ${newGroupId}`);
    } catch (err) {
      return retryOrLog(err, tabInfo, retryCount, "Failed to create new group");
    }
  } else {
    logger.log(
      `[handleTab] Adding tab ${tabId} to existing group '${groupInfo.title}'`
    );
    try {
      await chrome.tabs.group({ groupId: targetGroup.id, tabIds: tab.id });
    } catch (err) {
      return retryOrLog(err, tabInfo, retryCount, "Failed to add tab to group");
    }
  }
}

// --- Merge duplicate groups ---

// Our own merging moves tabs between groups and windows, which fires the very
// listeners that trigger merging. This flag keeps that from feeding back.
let isMerging = false;

/**
 * Folds duplicate tab groups into one.
 *
 * @param {{scope?: "window"|"all", windowId?: number|null}} [options]
 *   scope "window" only merges groups that already share a window (safe enough
 *   to run automatically); "all" also pulls tabs across windows.
 * @returns {Promise<{mergedGroups: number}>}
 */
async function mergeDuplicateGroups(options = {}) {
  const { scope = "all", windowId = null } = options;
  if (isMerging) {
    logger.log("[mergeGroups] Already merging; skipping re-entrant run.");
    return { mergedGroups: 0 };
  }
  isMerging = true;

  try {
    logger.log(`[mergeGroups] Starting merge, scope=${scope}.`);
    const query = windowId === null ? {} : { windowId };
    const allGroups = await chrome.tabGroups.query(query);

    // A service worker has no "current" window; the last focused one is the
    // closest stand-in for where the user is looking.
    let focusedWindowId = windowId;
    if (focusedWindowId === null) {
      try {
        const focused = await chrome.windows.getLastFocused();
        focusedWindowId = focused?.id ?? null;
      } catch (err) {
        logger.warn("[mergeGroups] Could not determine focused window:", err);
      }
    }

    const plans = planGroupMerges(allGroups, { scope, focusedWindowId });
    let mergedGroups = 0;

    for (const plan of plans) {
      logger.log(
        `[mergeGroups] Folding ${plan.sourceGroupIds.length} group(s) titled ` +
          `"${plan.title}" into ${plan.targetGroupId} (window ${plan.targetWindowId}).`
      );

      const nestedTabs = await Promise.all(
        plan.sourceGroupIds.map((id) => chrome.tabs.query({ groupId: id }))
      );
      const { movable, skipped } = partitionMovableTabs(nestedTabs.flat());
      if (skipped.length > 0) {
        logger.log(`[mergeGroups] Leaving ${skipped.length} pinned tab(s).`);
      }
      if (movable.length === 0) continue;

      try {
        if (!plan.sameWindow) {
          // Chrome will not carry a tab's group across a window boundary, and
          // moving a still-grouped tab between windows is where the old code
          // silently gave up. Ungroup first, then move, then regroup.
          await chrome.tabs.ungroup(movable);
          await chrome.tabs.move(movable, {
            windowId: plan.targetWindowId,
            index: -1,
          });
        }
        await chrome.tabs.group({
          groupId: plan.targetGroupId,
          tabIds: movable,
        });
        mergedGroups += plan.sourceGroupIds.length;
      } catch (err) {
        // One unmovable group (a tab mid-drag, a window closing) must not abort
        // the whole merge, and must never leave the caller without a response.
        logger.error(
          `[mergeGroups] Failed to merge groups titled "${plan.title}":`,
          err
        );
      }
    }

    logger.log(`[mergeGroups] Complete, merged ${mergedGroups} group(s).`);
    return { mergedGroups };
  } finally {
    isMerging = false;
  }
}

// Chrome hands tabs over one at a time when windows are combined, so collapse
// the burst into a single merge pass per window.
const pendingMergeWindows = new Set();
let mergeSweepTimer = null;

function scheduleWindowMerge(windowId) {
  if (isMerging || !Number.isInteger(windowId)) return;
  pendingMergeWindows.add(windowId);
  clearTimeout(mergeSweepTimer);
  mergeSweepTimer = setTimeout(async () => {
    const windows = [...pendingMergeWindows];
    pendingMergeWindows.clear();
    for (const id of windows) {
      try {
        await mergeDuplicateGroups({ scope: "window", windowId: id });
      } catch (err) {
        logger.error(`[mergeGroups] Auto-merge failed for window ${id}:`, err);
      }
    }
  }, 400);
}

// --- Sweeps ---
async function sweepUngroupedTabs(query) {
  let tabs;
  try {
    tabs = await chrome.tabs.query({
      ...query,
      groupId: chrome.tabGroups.TAB_GROUP_ID_NONE,
    });
  } catch (err) {
    logger.error("[sweep] Failed to query tabs:", err);
    return 0;
  }

  let queued = 0;
  for (const tab of tabs) {
    if (!tab.url || !tab.url.startsWith("http")) continue;
    if (enqueueTab({ tabId: tab.id, url: tab.url, windowId: tab.windowId })) {
      queued += 1;
    }
  }
  if (queued > 0) {
    logger.log(`[sweep] Queued ${queued} ungrouped tabs.`);
    processQueue();
  }
  return tabs.length;
}

// --- Event Listeners ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
  ) {
    if (enqueueTab({ tabId, url: tab.url, windowId: tab.windowId })) {
      processQueue();
    }
  }
});

// Dragging a window into another, or dragging one tab across, hands each tab
// to the destination window separately. Chrome recreates the groups there, so
// the window ends up with two groups of the same name -- the case that used to
// need a manual "Merge Groups" click.
chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  logger.log(`[onAttached] Tab ${tabId} arrived in window ${newWindowId}.`);
  scheduleWindowMerge(newWindowId);
});

// A group dragged between windows arrives as a new group rather than attached
// tabs, so watch group creation and movement too.
chrome.tabGroups?.onCreated?.addListener((group) => {
  logger.log(`[onGroupCreated] Group ${group.id} in window ${group.windowId}.`);
  scheduleWindowMerge(group.windowId);
});

chrome.tabGroups?.onMoved?.addListener((group) => {
  logger.log(`[onGroupMoved] Group ${group.id} in window ${group.windowId}.`);
  scheduleWindowMerge(group.windowId);
});

// Renaming a group can create a duplicate of one already in the window.
chrome.tabGroups?.onUpdated?.addListener((group) => {
  logger.log(`[onGroupUpdated] Group ${group.id} in window ${group.windowId}.`);
  scheduleWindowMerge(group.windowId);
});

// Rapid window switching used to trigger one full sweep per focus change.
let focusSweepTimer = null;
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  logger.log(`[onFocusChanged] Window focused: ${windowId}.`);
  clearTimeout(focusSweepTimer);
  focusSweepTimer = setTimeout(() => {
    sweepUngroupedTabs({ windowId });
  }, 400);
});

// --- Messages ---
const messageHandlers = {
  async consolidateTabs() {
    logger.log("[onMessage] Received request to consolidate tabs.");
    const tabsFound = await sweepUngroupedTabs({});
    return { status: "complete", tabsFound };
  },

  async mergeGroups() {
    logger.log("[onMessage] Received request to merge groups.");
    const { mergedGroups } = await mergeDuplicateGroups();
    return { status: "complete", mergedGroups };
  },

  async processSpecificTab(message) {
    if (!message.tabInfo) return { status: "error", message: "No tab info." };
    logger.log(
      `[onMessage] Received request to process specific tab: ${message.tabInfo.tabId}`
    );
    if (enqueueTab(message.tabInfo)) processQueue();
    return { status: "queued" };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = messageHandlers[message?.action];
  if (!handler) return false;

  // Every path must answer: the popup disables its buttons until it hears back.
  handler(message).then(sendResponse, (err) => {
    logger.error(`[onMessage] '${message.action}' failed:`, err);
    sendResponse({ status: "error", message: err?.message ?? String(err) });
  });
  return true; // async response
});
