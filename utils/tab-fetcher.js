import { logger } from "./logger.js";

const LIVE_PRICE_HOST_RE =
  /goldprice\.org|kitco\.com|investing\.com|tradingview\.com|monex\.com|apmex\.com/i;

export function needsLiveExtraction(tracker, { force = false } = {}) {
  if (force) return true;
  if (tracker.renderMode === "js-required" || tracker.renderMode === "tab") {
    return true;
  }
  if (tracker.valueType === "price" || tracker.valueType === "numeric") {
    return true;
  }
  try {
    return LIVE_PRICE_HOST_RE.test(new URL(tracker.url).hostname);
  } catch {
    return false;
  }
}

export function urlsMatchForTracker(trackerUrl, tabUrl) {
  try {
    const target = new URL(trackerUrl);
    const tab = new URL(tabUrl);
    if (target.origin !== tab.origin) return false;
    return /^https?:$/i.test(tab.protocol);
  } catch {
    return false;
  }
}

async function findOpenTab(trackerUrl) {
  let tabs = [];
  try {
    const { origin } = new URL(trackerUrl);
    tabs = await chrome.tabs.query({ url: `${origin}/*` });
  } catch {
    tabs = await chrome.tabs.query({});
  }

  const matches = tabs.filter(
    (t) =>
      t.id != null &&
      t.url &&
      urlsMatchForTracker(trackerUrl, t.url) &&
      !t.url.startsWith("chrome-extension://")
  );
  if (matches.length === 0) return null;

  const target = new URL(trackerUrl);
  const exact = matches.find((t) => {
    try {
      const u = new URL(t.url);
      return u.pathname === target.pathname;
    } catch {
      return false;
    }
  });
  return exact ?? matches[0];
}

async function waitForTabComplete(tabId, maxMs = 30000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab load timeout"));
    }, maxMs);

    const onUpdated = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function runExtractOnTab(tabId, tracker, maxWaitMs = 15000) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (selector, shadowSelector, maxWaitMs) => {
      function queryInDoc(doc, sel, shadow) {
        if (shadow?.host && shadow?.inner) {
          const hostEl = doc.querySelector(shadow.host);
          if (!hostEl?.shadowRoot) return null;
          return hostEl.shadowRoot.querySelector(shadow.inner);
        }
        let el = doc.querySelector(sel);
        if (el) return el;
        const all = doc.querySelectorAll("*");
        for (const node of all) {
          if (node.shadowRoot) {
            el = node.shadowRoot.querySelector(sel);
            if (el) return el;
          }
        }
        return null;
      }

      function searchDoc(doc) {
        const el = queryInDoc(doc, selector, shadowSelector);
        if (el) {
          const raw = (el.innerText ?? el.textContent ?? "").trim();
          if (raw) return raw;
        }
        for (const frame of doc.querySelectorAll("iframe")) {
          try {
            const child = frame.contentDocument;
            if (child) {
              const found = searchDoc(child);
              if (found) return found;
            }
          } catch {
            /* cross-origin */
          }
        }
        return null;
      }

      return new Promise((resolve) => {
        const deadline = Date.now() + maxWaitMs;
        const tick = () => {
          const raw = searchDoc(document);
          if (raw) {
            resolve(raw);
            return;
          }
          if (Date.now() >= deadline) {
            resolve(null);
            return;
          }
          setTimeout(tick, 400);
        };
        tick();
      });
    },
    args: [tracker.selector, tracker.shadowSelector ?? null, maxWaitMs]
  });

  const raw = results?.[0]?.result;
  return raw ?? null;
}

export async function extractFromOpenTab(tracker) {
  const tab = await findOpenTab(tracker.url);
  if (!tab?.id) return null;

  try {
    const raw = await runExtractOnTab(tab.id, tracker);
    if (raw) {
      await logger.info("Extracted from open tab", {
        trackerId: tracker.id,
        tabId: tab.id
      });
    }
    return raw;
  } catch (err) {
    await logger.warn("Open tab extract failed", {
      trackerId: tracker.id,
      error: err.message
    });
    return null;
  }
}

export async function extractViaBackgroundTab(tracker) {
  let tabId;
  try {
    const tab = await chrome.tabs.create({
      url: tracker.url,
      active: false
    });
    tabId = tab.id;
    if (!tabId) throw new Error("Could not open background tab");

    await waitForTabComplete(tabId, 35000);
    await new Promise((r) => setTimeout(r, 2500));

    const raw = await runExtractOnTab(tabId, tracker, 25000);
    if (raw) {
      await logger.info("Extracted via background tab", {
        trackerId: tracker.id,
        tabId
      });
    }
    return raw;
  } catch (err) {
    await logger.warn("Background tab extract failed", {
      trackerId: tracker.id,
      error: err.message
    });
    return null;
  } finally {
    if (tabId != null) {
      await chrome.tabs.remove(tabId).catch(() => {});
    }
  }
}

export async function tryTabExtraction(tracker, { allowBackground = false } = {}) {
  const fromOpen = await extractFromOpenTab(tracker);
  if (fromOpen) return fromOpen;
  if (!allowBackground) return null;
  return extractViaBackgroundTab(tracker);
}
