const LOG_KEY = "watchdog_logs";
const MAX_LOG_ENTRIES = 500;

export const logger = {
  async log(level, message, context = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      context
    };
    const result = await chrome.storage.local.get(LOG_KEY);
    const logs = result[LOG_KEY] ?? [];
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    }
    await chrome.storage.local.set({ [LOG_KEY]: logs });
  },
  info(msg, ctx) {
    return logger.log("info", msg, ctx);
  },
  warn(msg, ctx) {
    return logger.log("warn", msg, ctx);
  },
  error(msg, ctx) {
    return logger.log("error", msg, ctx);
  },
  async getAll() {
    const result = await chrome.storage.local.get(LOG_KEY);
    return result[LOG_KEY] ?? [];
  },
  async clear() {
    await chrome.storage.local.set({ [LOG_KEY]: [] });
  }
};

export { LOG_KEY, MAX_LOG_ENTRIES };
