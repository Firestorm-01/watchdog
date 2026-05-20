const MAX_TRACKERS = 200;
const MAX_IMPORT_BATCH = 50;
const MAX_LABEL_LEN = 120;
const MAX_SELECTOR_LEN = 800;
const MAX_URL_LEN = 2048;

const BLOCKED_URL_PREFIXES = [
  "chrome://",
  "chrome-extension://",
  "edge://",
  "about:",
  "devtools://",
  "view-source:",
  "file://",
  "data:",
  "javascript:"
];

export function isTrackableUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.length > MAX_URL_LEN) return false;
  const lower = url.trim().toLowerCase();
  if (BLOCKED_URL_PREFIXES.some((p) => lower.startsWith(p))) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidSelector(selector) {
  if (!selector || typeof selector !== "string") return false;
  const s = selector.trim();
  if (s.length === 0 || s.length > MAX_SELECTOR_LEN) return false;
  if (/<script/i.test(s) || /javascript:/i.test(s)) return false;
  return /^[#.[\w-*]/.test(s) || s.includes(">") || s.includes("[");
}

export function sanitizeLabel(label) {
  return String(label ?? "Untitled tracker")
    .trim()
    .slice(0, MAX_LABEL_LEN);
}

export function validateTrackerPayload(payload, { existingCount = 0 } = {}) {
  const errors = [];

  if (!payload?.url || !isTrackableUrl(payload.url)) {
    errors.push("A valid http(s) page URL is required.");
  }
  if (!payload?.selector?.trim()) {
    errors.push("A CSS selector is required.");
  } else if (payload.selector.length > MAX_SELECTOR_LEN) {
    errors.push("Selector is too long.");
  }
  if (!String(payload.label ?? "").trim()) {
    errors.push("A label is required.");
  }

  const interval = Number(payload.intervalMinutes);
  if (!Number.isFinite(interval) || interval < 5 || interval > 1440) {
    errors.push("Interval must be between 5 and 1440 minutes.");
  }

  const renotify = Number(payload.renotifyAfterMinutes ?? 0);
  if (!Number.isFinite(renotify) || renotify < 0 || renotify > 10080) {
    errors.push("Re-notify interval must be between 0 and 10080 minutes.");
  }

  if (existingCount >= MAX_TRACKERS) {
    errors.push(`Maximum of ${MAX_TRACKERS} trackers reached.`);
  }

  if (payload.condition?.type) {
    const validTypes = [
      "drops_below",
      "rises_above",
      "contains",
      "becomes_available",
      "changes"
    ];
    if (!validTypes.includes(payload.condition.type)) {
      errors.push("Invalid condition type.");
    }
    if (
      ["drops_below", "rises_above"].includes(payload.condition.type) &&
      !Number.isFinite(Number(payload.condition.value))
    ) {
      errors.push("Condition threshold must be a number.");
    }
    if (
      payload.condition.type === "contains" &&
      !String(payload.condition.value ?? "").trim()
    ) {
      errors.push("Condition text is required.");
    }
  }

  return { ok: errors.length === 0, errors };
}

export function sanitizeImportedTracker(raw) {
  if (!raw || typeof raw !== "object") return null;
  const allowed = [
    "id",
    "url",
    "selector",
    "shadowSelector",
    "label",
    "renderMode",
    "requiresCookies",
    "intervalMinutes",
    "condition",
    "renotifyAfterMinutes",
    "status"
  ];
  const clean = {};
  for (const key of allowed) {
    if (raw[key] !== undefined) clean[key] = raw[key];
  }
  if (!isTrackableUrl(clean.url) || !clean.selector?.trim()) return null;
  clean.label = sanitizeLabel(clean.label);
  clean.status = ["active", "paused", "error", "needs_attention"].includes(
    clean.status
  )
    ? clean.status
    : "active";
  return clean;
}

export function validateImportBatch(trackers, existingCount) {
  if (!Array.isArray(trackers)) {
    return { ok: false, errors: ["Import file must be a JSON array."] };
  }
  if (trackers.length > MAX_IMPORT_BATCH) {
    return {
      ok: false,
      errors: [`Import limited to ${MAX_IMPORT_BATCH} trackers per batch.`]
    };
  }
  if (existingCount + trackers.length > MAX_TRACKERS) {
    return {
      ok: false,
      errors: [`Would exceed maximum of ${MAX_TRACKERS} trackers.`]
    };
  }
  return { ok: true, errors: [] };
}

export { MAX_TRACKERS, MAX_IMPORT_BATCH };
