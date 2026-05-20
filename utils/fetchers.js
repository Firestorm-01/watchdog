import { fetchSemaphore } from "./semaphore.js";
import { extractFromDocument } from "./extract.js";
import { logger } from "./logger.js";
import {
  needsLiveExtraction,
  tryTabExtraction
} from "./tab-fetcher.js";

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "Cache-Control": "no-cache",
  Pragma: "no-cache"
};

const lastFetchByDomain = {};

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function throttledFetch(url, options, minIntervalMs = 10000) {
  const domain = new URL(url).hostname;
  const now = Date.now();
  const lastFetch = lastFetchByDomain[domain] ?? 0;
  const wait = Math.max(0, minIntervalMs - (now - lastFetch));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastFetchByDomain[domain] = Date.now();
  return fetchWithTimeout(url, options);
}

export class StaticFetcher {
  async fetch(tracker, domainMinIntervalMs) {
    await fetchSemaphore.acquire();
    try {
      const response = await throttledFetch(
        tracker.url,
        { headers: FETCH_HEADERS, credentials: "omit" },
        domainMinIntervalMs
      );
      return { response, html: await response.text() };
    } finally {
      fetchSemaphore.release();
    }
  }

  parse(html) {
    if (typeof DOMParser === "undefined") {
      throw new Error("DOMParser is not available in this context");
    }
    const parser = new DOMParser();
    return parser.parseFromString(html, "text/html");
  }
}

export class CookieFetcher extends StaticFetcher {
  async fetch(tracker, domainMinIntervalMs) {
    await fetchSemaphore.acquire();
    try {
      const url = new URL(tracker.url);
      const cookies = await chrome.cookies.getAll({ domain: url.hostname });
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const headers = { ...FETCH_HEADERS };
      if (cookieHeader) {
        headers.Cookie = cookieHeader;
      }
      const response = await throttledFetch(
        tracker.url,
        { headers, credentials: "omit" },
        domainMinIntervalMs
      );
      return { response, html: await response.text() };
    } finally {
      fetchSemaphore.release();
    }
  }
}

let offscreenMutex = Promise.resolve();

async function waitForOffscreenReady(maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" }, (response) => {
        resolve(!chrome.runtime.lastError && response?.ready === true);
      });
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Offscreen document not ready");
}

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen/offscreen.html"),
      reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
      justification:
        "Extract DOM content from JS-rendered pages for change tracking"
    });
  }
  await waitForOffscreenReady();
}

export async function withOffscreen(fn) {
  const run = offscreenMutex.then(async () => {
    await ensureOffscreenDocument();
    try {
      return await fn();
    } finally {
      await chrome.offscreen.closeDocument().catch(() => {});
    }
  });
  offscreenMutex = run.catch(() => {});
  return run;
}

export async function parseAndExtractViaOffscreen(html, tracker) {
  return withOffscreen(
    () =>
      new Promise((resolve, reject) => {
        const timeoutId = setTimeout(
          () => reject(new Error("Offscreen parse timeout")),
          15000
        );
        chrome.runtime.sendMessage(
          {
            type: "OFFSCREEN_PARSE_HTML",
            payload: {
              html,
              selector: tracker.selector,
              shadowSelector: tracker.shadowSelector
            }
          },
          (response) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response?.success) {
              reject(new Error(response?.error || "Offscreen parse failed"));
              return;
            }
            resolve(response.data);
          }
        );
      })
  );
}

export async function fetchViaOffscreen(url, selector, shadowSelector) {
  return withOffscreen(
    () =>
      new Promise((resolve, reject) => {
        const timeoutId = setTimeout(
          () => reject(new Error("Offscreen timeout")),
          30000
        );
        chrome.runtime.sendMessage(
          {
            type: "OFFSCREEN_FETCH",
            payload: { url, selector, shadowSelector }
          },
          (response) => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            if (!response?.success) {
              reject(new Error(response?.error || "Offscreen fetch failed"));
              return;
            }
            resolve(response.data);
          }
        );
      })
  );
}

export class OffscreenFetcher {
  async fetch(tracker) {
    const data = await fetchViaOffscreen(
      tracker.url,
      tracker.selector,
      tracker.shadowSelector
    );
    return {
      response: { ok: data.ok, status: data.status ?? 200 },
      html: null,
      offscreenResult: data
    };
  }
}

export function getFetcher(tracker) {
  if (tracker.renderMode === "js-required") {
    return new OffscreenFetcher();
  }
  if (tracker.requiresCookies) {
    return new CookieFetcher();
  }
  return new StaticFetcher();
}

function liveTabSuccess(tracker, raw) {
  const wasLive = tracker.renderMode === "tab";
  tracker.renderMode = "tab";
  return {
    success: true,
    raw,
    extraction: { ok: true, raw },
    usedLiveTab: true,
    renderModeUpdated: !wasLive
  };
}

async function tryLiveTabPipeline(tracker, { allowBackground = false } = {}) {
  const raw = await tryTabExtraction(tracker, { allowBackground });
  if (!raw) return null;
  return liveTabSuccess(tracker, raw);
}

export async function runFetchPipeline(tracker, settings, { force = false } = {}) {
  const fetcher = getFetcher(tracker);
  let response;
  let offscreenResult;
  const useLive = needsLiveExtraction(tracker, { force });

  try {
    const openTabResult = await tryLiveTabPipeline(tracker);
    if (openTabResult) return openTabResult;

    if (useLive) {
      const bgFirst = await tryLiveTabPipeline(tracker, {
        allowBackground: true
      });
      if (bgFirst) return bgFirst;
    }

    if (tracker.renderMode === "tab") {
      return {
        success: false,
        reason: "selectorMissing",
        error:
          "Could not read live price. Open the page in Chrome, or delete and re-pick only the price number."
      };
    }

    if (fetcher instanceof OffscreenFetcher) {
      const result = await fetcher.fetch(tracker);
      offscreenResult = result.offscreenResult;
      if (offscreenResult?.ok) {
        return liveTabSuccess(tracker, offscreenResult.raw);
      }
      const bgTabResult = await tryLiveTabPipeline(tracker, {
        allowBackground: true
      });
      if (bgTabResult) return bgTabResult;
      return {
        success: false,
        error: offscreenResult?.error || "Offscreen extraction failed",
        status: offscreenResult?.status
      };
    }

    const { response: res, html } = await fetcher.fetch(
      tracker,
      settings.domainMinIntervalMs
    );
    response = res;

    if (!response.ok) {
      if (response.status === 403 || response.status === 401) {
        const tabResult = await tryLiveTabPipeline(tracker, {
          allowBackground: true
        });
        if (tabResult) return tabResult;
      }
      return {
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`
      };
    }

    const extraction =
      typeof DOMParser !== "undefined"
        ? extractFromDocument(fetcher.parse(html), tracker)
        : await parseAndExtractViaOffscreen(html, tracker);

    if (!extraction.ok) {
      if (extraction.reason === "js-required") {
        await logger.info("JS rendering detected, switching to offscreen", {
          trackerId: tracker.id
        });
        tracker.renderMode = "js-required";
        const offFetcher = new OffscreenFetcher();
        const offResult = await offFetcher.fetch(tracker);
        offscreenResult = offResult.offscreenResult;
        if (offscreenResult?.ok) {
          return liveTabSuccess(tracker, offscreenResult.raw);
        }
        const bgAfterJs = await tryLiveTabPipeline(tracker, {
          allowBackground: true
        });
        if (bgAfterJs) return bgAfterJs;
        return {
          success: false,
          reason: "js-required",
          error: offscreenResult?.error || "Offscreen fallback failed"
        };
      }
      const bgAfterMissing = await tryLiveTabPipeline(tracker, {
        allowBackground: true
      });
      if (bgAfterMissing) return bgAfterMissing;
      return {
        success: false,
        reason: "selectorMissing",
        error: "Selector not found in page"
      };
    }

    if (extraction.jsSignals >= 1 && tracker.renderMode !== "js-required") {
      await logger.info("Sparse static HTML; verifying via offscreen", {
        trackerId: tracker.id,
        jsSignals: extraction.jsSignals
      });
      tracker.renderMode = "js-required";
      const offFetcher = new OffscreenFetcher();
      const offResult = await offFetcher.fetch(tracker);
      const live = offResult.offscreenResult;
      if (live?.ok && live.raw) {
        return liveTabSuccess(tracker, live.raw);
      }
      const bgAfterVerify = await tryLiveTabPipeline(tracker, {
        allowBackground: true
      });
      if (bgAfterVerify) return bgAfterVerify;
    }

    if (useLive) {
      const bgFinal = await tryLiveTabPipeline(tracker, {
        allowBackground: true
      });
      if (bgFinal) return bgFinal;
    }

    return {
      success: true,
      raw: extraction.raw,
      extraction
    };
  } catch (err) {
    const tabOnError = await tryTabExtraction(tracker, {
      allowBackground: true
    }).catch(() => null);
    if (tabOnError) {
      return liveTabSuccess(tracker, tabOnError);
    }
    const isAbort = err.name === "AbortError";
    return {
      success: false,
      error: isAbort ? "Request timed out" : err.message,
      networkError: true
    };
  }
}
