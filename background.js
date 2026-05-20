import { storage, createTracker } from "./utils/storage.js";
import { MessageTypes } from "./utils/messages.js";
import { logger } from "./utils/logger.js";
import {
  detectType,
  normalize,
  evaluateCondition,
  formatNormalizedForDisplay
} from "./utils/normalizer.js";
import { runFetchPipeline } from "./utils/fetchers.js";
import {
  maybeNotify,
  notifyRateLimited,
  notifyAccessDenied
} from "./utils/notifier.js";
import { recordHealthMetrics, getAllMetrics } from "./utils/metrics.js";
import {
  isTrackableUrl,
  validateTrackerPayload,
  sanitizeLabel,
  sanitizeImportedTracker,
  validateImportBatch
} from "./utils/validate.js";

const MASTER_ALARM = "watchdog-master-tick";
const STALE_CHECK_MS = 120000;
const CONTEXT_MENU_PICK = "watchdog-pick-element";
const CONTEXT_MENU_OPTIONS = "watchdog-open-options";

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_PICK,
      title: "WatchDog: Pick element to track",
      contexts: ["page", "frame", "selection"]
    });
    chrome.contextMenus.create({
      id: CONTEXT_MENU_OPTIONS,
      title: "WatchDog: Open dashboard",
      contexts: ["action"]
    });
  });
}

async function registerMasterAlarm() {
  const alarm = await chrome.alarms.get(MASTER_ALARM);
  if (!alarm) {
    await chrome.alarms.create(MASTER_ALARM, { periodInMinutes: 1 });
    await logger.info("Master alarm registered");
  }
}

async function recoverStaleCheck() {
  const flag = await storage.getCheckInProgress();
  if (!flag?.checkInProgress) return;

  const started = new Date(flag.checkStartedAt).getTime();
  if (Date.now() - started > STALE_CHECK_MS) {
    await logger.warn("Stale check recovered", {
      trackerId: flag.checkTrackerId
    });
    const tracker = await storage.getTracker(flag.checkTrackerId);
    if (tracker) {
      tracker.consecutiveFailures = (tracker.consecutiveFailures ?? 0) + 1;
      tracker.backoffUntil = Date.now() + computeBackoff(tracker.consecutiveFailures);
      tracker.errorMessage = "Check timed out (service worker recovered)";
      await storage.upsertTracker(tracker);
    }
    await storage.setCheckInProgress(null);
  }
}

async function recoverMissedChecks() {
  const trackers = await storage.getAllTrackers();
  const now = Date.now();
  const missed = trackers.filter(
    (t) =>
      t.status === "active" &&
      (!t.backoffUntil || t.backoffUntil < now) &&
      t.nextCheckAt < now
  );
  if (missed.length > 0) {
    await logger.info("Recovering missed checks on cold start", {
      count: missed.length
    });
    await processQueue(missed);
  }
}

async function onStartup() {
  await registerMasterAlarm();
  await recoverStaleCheck();
  await recoverMissedChecks();
}

chrome.runtime.onInstalled.addListener((details) => {
  setupContextMenus();
  if (details.reason === "install") {
    void logger.info("WatchDog installed");
  }
  onStartup();
});

chrome.runtime.onStartup?.addListener?.(() => onStartup());

self.addEventListener("activate", (event) => {
  event.waitUntil(onStartup());
});

onStartup();

function computeBackoff(consecutiveFailures) {
  return Math.min(Math.pow(2, consecutiveFailures) * 60000, 1800000);
}

async function processTracker(tracker, settings, { force = false } = {}) {
  const now = Date.now();
  if (!force) {
    if (tracker.status !== "active") return tracker;
    if (tracker.backoffUntil && tracker.backoffUntil > now) return tracker;
  }

  const checkStarted = performance.now();
  let result = { success: false, error: "Check aborted" };

  await storage.setCheckInProgress({
    checkInProgress: true,
    checkStartedAt: new Date().toISOString(),
    checkTrackerId: tracker.id
  });

  try {
    if (!isTrackableUrl(tracker.url)) {
      tracker.status = "error";
      tracker.errorMessage = "Invalid or unsupported page URL";
      result = { success: false, error: tracker.errorMessage };
      await storage.upsertTracker(tracker);
      return tracker;
    }

    result = await runFetchPipeline(tracker, settings, { force });
    tracker.totalChecks = (tracker.totalChecks ?? 0) + 1;
    tracker.lastChecked = new Date().toISOString();

    if (result.renderModeUpdated && !result.usedLiveTab) {
      tracker.renderMode = "js-required";
      tracker.status = "needs_attention";
      tracker.errorMessage =
        "Page appears JS-rendered; using offscreen fallback.";
    } else if (result.usedLiveTab) {
      tracker.renderMode = "tab";
      if (tracker.status === "needs_attention" && tracker.consecutiveSuccesses >= 1) {
        tracker.status = "active";
        tracker.errorMessage = null;
      }
    }

    if (!result.success) {
      tracker.consecutiveFailures = (tracker.consecutiveFailures ?? 0) + 1;
      tracker.consecutiveSuccesses = 0;

      if (result.status === 429) {
        tracker.backoffUntil = Date.now() + 3600000;
        tracker.status = "paused";
        tracker.errorMessage =
          "Site is rate-limiting WatchDog. Tracker paused 1 hour.";
        await notifyRateLimited(tracker);
      } else if (result.status === 403 || result.status === 401) {
        tracker.status = "error";
        tracker.errorMessage = "Access denied. Page may require login.";
        await notifyAccessDenied(tracker);
      } else if (result.reason === "selectorMissing") {
        tracker.selectorMisses = (tracker.selectorMisses ?? 0) + 1;
        tracker.errorMessage = "Selector not found on page";
        if (tracker.selectorMisses >= 3) {
          tracker.status = "needs_attention";
          tracker.errorMessage =
            "Selector may have drifted (3+ consecutive misses)";
        }
      } else if (result.reason === "js-required") {
        tracker.status = "needs_attention";
        tracker.renderMode = "js-required";
        tracker.errorMessage =
          result.error ||
          "Page requires JavaScript; live tab extraction failed.";
      } else {
        const backoffMs = computeBackoff(tracker.consecutiveFailures);
        tracker.backoffUntil = Date.now() + backoffMs;
        tracker.errorMessage = result.error || "Check failed";
        if (!force && tracker.consecutiveFailures >= 5) {
          tracker.status = "error";
        }
      }
    } else {
      tracker.consecutiveFailures = 0;
      tracker.consecutiveSuccesses = (tracker.consecutiveSuccesses ?? 0) + 1;
      tracker.selectorMisses = 0;
      if (!force || tracker.status === "paused") {
        tracker.backoffUntil = null;
      }
      if (tracker.status === "error" || tracker.status === "needs_attention") {
        if (tracker.consecutiveSuccesses >= 2) {
          tracker.status = "active";
          tracker.errorMessage = null;
        }
      }

      const raw = result.raw ?? "";
      const valueType = detectType(raw);
      const newNormalized = normalize(raw, valueType);
      const oldNormalized = tracker.lastNormalized;
      const oldDisplay = formatNormalizedForDisplay(
        oldNormalized,
        tracker.valueType
      );
      const newDisplay = formatNormalizedForDisplay(newNormalized, valueType);

      const conditionMet = evaluateCondition(
        tracker.condition,
        oldNormalized,
        newNormalized
      );

      const valueChanged =
        tracker.lastValue !== null &&
        (oldNormalized !== newNormalized || tracker.lastValue !== raw);

      if (valueChanged) {
        tracker.totalChanges = (tracker.totalChanges ?? 0) + 1;
        await storage.appendHistory(tracker.id, {
          ts: new Date().toISOString(),
          oldValue: tracker.lastValue,
          newValue: raw,
          oldNormalized,
          newNormalized
        });
        const notifyResult = await maybeNotify(
          tracker,
          oldDisplay,
          newDisplay,
          conditionMet,
          settings
        );
        if (notifyResult) {
          tracker.notifiedValue = notifyResult.notifiedValue;
          tracker.lastNotifiedAt = notifyResult.lastNotifiedAt;
        }
      } else if (
        tracker.lastValue !== null &&
        conditionMet &&
        tracker.notifiedValue !== String(newDisplay)
      ) {
        const notifyResult = await maybeNotify(
          tracker,
          oldDisplay,
          newDisplay,
          true,
          settings
        );
        if (notifyResult) {
          tracker.notifiedValue = notifyResult.notifiedValue;
          tracker.lastNotifiedAt = notifyResult.lastNotifiedAt;
        }
      }

      tracker.lastValue = raw;
      tracker.lastNormalized = newNormalized;
      tracker.valueType = valueType;
    }

    if (force) {
      tracker.nextCheckAt = Date.now() + tracker.intervalMinutes * 60000;
    } else {
      tracker.nextCheckAt = Date.now() + tracker.intervalMinutes * 60000;
    }
    await storage.upsertTracker(tracker);
    return tracker;
  } catch (err) {
    await logger.error("processTracker exception", {
      trackerId: tracker.id,
      error: err.message
    });
    tracker.consecutiveFailures = (tracker.consecutiveFailures ?? 0) + 1;
    tracker.errorMessage = err.message;
    result = { success: false, error: err.message };
    await storage.upsertTracker(tracker);
    return tracker;
  } finally {
    const durationMs = performance.now() - checkStarted;
    await recordHealthMetrics(tracker, result, durationMs);
    await storage.setCheckInProgress(null);
  }
}

async function processQueue(trackers, options = {}) {
  const settings = await storage.getSettings();
  const sorted = [...trackers].sort((a, b) => a.nextCheckAt - b.nextCheckAt);
  for (const tracker of sorted) {
    try {
      await processTracker(tracker, settings, options);
    } catch (err) {
      await logger.error("processTracker failed", {
        trackerId: tracker.id,
        error: err.message
      });
    }
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== MASTER_ALARM) return;
  await recoverStaleCheck();
  const trackers = await storage.getAllTrackers();
  const now = Date.now();
  const due = trackers.filter(
    (t) =>
      t.status === "active" &&
      (!t.backoffUntil || t.backoffUntil < now) &&
      t.nextCheckAt <= now
  );
  if (due.length > 0) {
    await logger.info("Master tick processing", { due: due.length });
    await processQueue(due);
  }
});

async function startPickSession(tabId, sessionId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url || !isTrackableUrl(tab.url)) {
    throw new Error(
      "Cannot pick on this page. Open a normal http(s) website first."
    );
  }

  await storage.setPickSession({
    sessionId,
    tabId,
    status: "pending",
    startedAt: new Date().toISOString(),
    url: tab.url
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"]
    });
  } catch (err) {
    await storage.setPickSession({
      sessionId,
      tabId,
      status: "error",
      error: err.message
    });
    throw new Error(
      "Could not start picker. Try refreshing the page, or check extension permissions."
    );
  }
}

function respond(success, data, error) {
  return { success, data, error };
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_OPTIONS) {
    chrome.runtime.openOptionsPage();
    return;
  }
  if (info.menuItemId === CONTEXT_MENU_PICK && tab?.id) {
    try {
      const sessionId = crypto.randomUUID();
      await startPickSession(tab.id, sessionId);
    } catch (err) {
      await logger.error("Context menu pick failed", { error: err.message });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  (async () => {
    try {
      switch (type) {
        case MessageTypes.GET_ALL_TRACKERS: {
          return respond(true, await storage.getAllTrackers());
        }
        case MessageTypes.GET_SETTINGS: {
          return respond(true, await storage.getSettings());
        }
        case MessageTypes.UPDATE_SETTINGS: {
          const interval = Number(payload.defaultIntervalMinutes);
          const domainSec = Number(payload.domainMinIntervalMs);
          if (interval < 5 || interval > 1440) {
            return respond(false, null, "Default interval must be 5–1440 minutes.");
          }
          if (domainSec < 1000 || domainSec > 120000) {
            return respond(false, null, "Domain throttle must be 1–120 seconds.");
          }
          await storage.setSettings(payload);
          return respond(true, await storage.getSettings());
        }
        case MessageTypes.GET_LOGS: {
          return respond(true, await logger.getAll());
        }
        case MessageTypes.CLEAR_LOGS: {
          await logger.clear();
          return respond(true, null);
        }
        case MessageTypes.GET_TRACKER_HISTORY: {
          return respond(true, await storage.getHistory(payload.trackerId));
        }
        case MessageTypes.GET_TRACKER_METRICS: {
          return respond(true, await storage.getMetrics(payload.trackerId));
        }
        case MessageTypes.GET_ALL_METRICS: {
          return respond(true, await getAllMetrics());
        }
        case MessageTypes.EXPORT_TRACKERS: {
          return respond(true, await storage.getAllTrackers());
        }
        case MessageTypes.IMPORT_TRACKERS: {
          const existing = await storage.getAllTrackers();
          const batchCheck = validateImportBatch(
            payload.trackers,
            existing.length
          );
          if (!batchCheck.ok) {
            return respond(false, null, batchCheck.errors.join(" "));
          }
          const merged = [...existing];
          let imported = 0;
          for (const raw of payload.trackers) {
            const clean = sanitizeImportedTracker(raw);
            if (!clean) continue;
            const tracker = createTracker(clean);
            const idx = merged.findIndex((m) => m.id === tracker.id);
            if (idx >= 0) merged[idx] = tracker;
            else merged.push(tracker);
            imported++;
          }
          await chrome.storage.local.set({ trackers: merged });
          await logger.info("Trackers imported", { count: imported });
          return respond(true, { merged, imported });
        }
        case MessageTypes.START_PICK_SESSION: {
          await startPickSession(payload.tabId, payload.sessionId);
          return respond(true, { sessionId: payload.sessionId });
        }
        case MessageTypes.CANCEL_PICK_SESSION: {
          await storage.setPickSession(null);
          if (payload?.tabId) {
            try {
              await chrome.tabs.sendMessage(payload.tabId, {
                type: "PICK_CANCEL_EXTERNAL"
              });
            } catch {
              /* tab closed */
            }
          }
          return respond(true, null);
        }
        case MessageTypes.PICK_COMPLETE: {
          if (!payload?.selector?.trim()) {
            return respond(false, null, "Invalid pick result.");
          }
          const session = await storage.getPickSession();
          await storage.setPickSession({
            ...(session ?? {}),
            sessionId: payload.sessionId ?? session?.sessionId,
            tabId: session?.tabId,
            status: "complete",
            selector: payload.selector.trim(),
            preview: String(payload.preview ?? "").slice(0, 200),
            shadowSelector: payload.shadowSelector ?? null,
            url: payload.url,
            shadowWarning: !!payload.shadowWarning
          });
          return respond(true, null);
        }
        case MessageTypes.PICK_CANCELLED: {
          await storage.setPickSession(null);
          return respond(true, null);
        }
        case MessageTypes.CREATE_TRACKER: {
          const existing = await storage.getAllTrackers();
          const validation = validateTrackerPayload(payload, {
            existingCount: existing.length
          });
          if (!validation.ok) {
            return respond(false, null, validation.errors.join(" "));
          }
          const settings = await storage.getSettings();
          const intervalMinutes = Math.min(
            1440,
            Math.max(5, Number(payload.intervalMinutes) || settings.defaultIntervalMinutes)
          );
          const tracker = createTracker({
            label: sanitizeLabel(payload.label),
            url: payload.url.trim(),
            selector: payload.selector.trim(),
            shadowSelector: payload.shadowSelector ?? null,
            intervalMinutes,
            condition: payload.condition ?? null,
            requiresCookies: !!payload.requiresCookies,
            renotifyAfterMinutes:
              payload.renotifyAfterMinutes ??
              settings.defaultRenotifyAfterMinutes,
            nextCheckAt: Date.now() + Math.random() * intervalMinutes * 60000
          });
          await storage.upsertTracker(tracker);
          await logger.info("Tracker created", { trackerId: tracker.id });
          return respond(true, tracker);
        }
        case MessageTypes.DELETE_TRACKER: {
          await storage.deleteTracker(payload.id);
          return respond(true, null);
        }
        case MessageTypes.PAUSE_TRACKER: {
          const t = await storage.getTracker(payload.id);
          if (t) {
            t.status = "paused";
            await storage.upsertTracker(t);
          }
          return respond(true, t);
        }
        case MessageTypes.RESUME_TRACKER: {
          const t = await storage.getTracker(payload.id);
          if (t) {
            t.status = "active";
            t.backoffUntil = null;
            t.consecutiveFailures = 0;
            t.nextCheckAt =
              Date.now() + Math.random() * t.intervalMinutes * 60000;
            await storage.upsertTracker(t);
          }
          return respond(true, t);
        }
        case MessageTypes.CHECK_NOW: {
          const t = await storage.getTracker(payload.id);
          if (!t) return respond(false, null, "Tracker not found");
          const settings = await storage.getSettings();
          const updated = await processTracker(t, settings, { force: true });
          return respond(true, updated);
        }
        default:
          return respond(false, null, `Unknown message type: ${type}`);
      }
    } catch (err) {
      await logger.error("Message handler error", {
        type,
        error: err.message
      });
      return respond(false, null, err.message);
    }
  })().then(sendResponse);

  return true;
});

chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.runtime.openOptionsPage();
  chrome.notifications.clear(notificationId);
});
