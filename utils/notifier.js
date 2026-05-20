import { storage } from "./storage.js";
import { logger } from "./logger.js";

export async function maybeNotify(
  tracker,
  oldDisplay,
  newDisplay,
  conditionMet,
  settings
) {
  if (!conditionMet || !settings.notificationsEnabled) return;

  if (tracker.notifiedValue === String(newDisplay)) {
    if (tracker.renotifyAfterMinutes > 0 && tracker.lastNotifiedAt) {
      const elapsed = Date.now() - tracker.lastNotifiedAt;
      if (elapsed < tracker.renotifyAfterMinutes * 60000) {
        return;
      }
    } else {
      return;
    }
  }

  const notificationId = `change-${tracker.id}-${Date.now()}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `WatchDog: ${tracker.label}`,
    message: `Changed: "${oldDisplay ?? "—"}" → "${newDisplay}"`,
    priority: 2,
    requireInteraction: true
  });

  await logger.info("Notification sent", {
    trackerId: tracker.id,
    oldDisplay,
    newDisplay
  });

  return {
    notifiedValue: String(newDisplay),
    lastNotifiedAt: Date.now()
  };
}

export async function notifyRateLimited(tracker) {
  await chrome.notifications.create(`rate-${tracker.id}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `WatchDog: ${tracker.label}`,
    message: "Site is rate-limiting WatchDog. Tracker paused 1 hour.",
    priority: 2,
    requireInteraction: true
  });
}

export async function notifyAccessDenied(tracker) {
  await chrome.notifications.create(`auth-${tracker.id}-${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: `WatchDog: ${tracker.label}`,
    message: "Access denied. Page may require login.",
    priority: 2
  });
}
