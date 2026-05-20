const DEFAULT_SETTINGS = {
  defaultIntervalMinutes: 15,
  domainMinIntervalMs: 10000,
  notificationsEnabled: true,
  defaultRenotifyAfterMinutes: 0
};

export const storage = {
  async getAllTrackers() {
    const result = await chrome.storage.local.get("trackers");
    return result.trackers ?? [];
  },

  async getTracker(id) {
    const all = await this.getAllTrackers();
    return all.find((t) => t.id === id) ?? null;
  },

  async upsertTracker(tracker) {
    const all = await this.getAllTrackers();
    const idx = all.findIndex((t) => t.id === tracker.id);
    if (idx >= 0) {
      all[idx] = tracker;
    } else {
      all.push(tracker);
    }
    await chrome.storage.local.set({ trackers: all });
    return tracker;
  },

  async deleteTracker(id) {
    const all = await this.getAllTrackers();
    const filtered = all.filter((t) => t.id !== id);
    await chrome.storage.local.set({ trackers: filtered });
    await chrome.storage.local.remove(`history:${id}`);
    await chrome.storage.local.remove(`metrics:${id}`);
  },

  async getHistory(trackerId) {
    const result = await chrome.storage.local.get(`history:${trackerId}`);
    return result[`history:${trackerId}`] ?? [];
  },

  async appendHistory(trackerId, entry) {
    const history = await this.getHistory(trackerId);
    history.push(entry);
    if (history.length > 100) {
      history.splice(0, history.length - 100);
    }
    await chrome.storage.local.set({ [`history:${trackerId}`]: history });
  },

  async getMetrics(trackerId) {
    const result = await chrome.storage.local.get(`metrics:${trackerId}`);
    return result[`metrics:${trackerId}`] ?? null;
  },

  async setMetrics(trackerId, metrics) {
    await chrome.storage.local.set({ [`metrics:${trackerId}`]: metrics });
  },

  async getSettings() {
    const result = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...(result.settings ?? {}) };
  },

  async setSettings(settings) {
    const current = await this.getSettings();
    await chrome.storage.local.set({ settings: { ...current, ...settings } });
  },

  async getCheckInProgress() {
    const result = await chrome.storage.local.get("checkInProgress");
    return result.checkInProgress ?? null;
  },

  async setCheckInProgress(flag) {
    if (flag === null) {
      await chrome.storage.local.remove("checkInProgress");
    } else {
      await chrome.storage.local.set({ checkInProgress: flag });
    }
  },

  async getPickSession() {
    const result = await chrome.storage.local.get("pickSession");
    return result.pickSession ?? null;
  },

  async setPickSession(session) {
    if (session === null) {
      await chrome.storage.local.remove("pickSession");
    } else {
      await chrome.storage.local.set({ pickSession: session });
    }
  }
};

export function createTracker(partial = {}) {
  const now = Date.now();
  const intervalMinutes = Math.min(
    1440,
    Math.max(5, partial.intervalMinutes ?? 15)
  );
  const defaults = {
    id: crypto.randomUUID(),
    url: "",
    selector: "",
    shadowSelector: null,
    label: "Untitled tracker",
    renderMode: "static",
    requiresCookies: false,
    lastValue: null,
    lastNormalized: null,
    valueType: "text",
    lastChecked: null,
    nextCheckAt: now + Math.random() * intervalMinutes * 60000,
    intervalMinutes,
    condition: null,
    notifiedValue: null,
    lastNotifiedAt: null,
    renotifyAfterMinutes: 0,
    status: "active",
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    selectorMisses: 0,
    backoffUntil: null,
    totalChecks: 0,
    totalChanges: 0,
    createdAt: new Date().toISOString(),
    errorMessage: null
  };
  return { ...defaults, ...partial, intervalMinutes };
}
