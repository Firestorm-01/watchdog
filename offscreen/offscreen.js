import { extractFromHtml } from "../utils/extract.js";

const iframe = document.getElementById("target-frame");

function queryInDocument(doc, selector, shadowSelector) {
  if (shadowSelector?.host && shadowSelector?.inner) {
    const hostEl = doc.querySelector(shadowSelector.host);
    if (!hostEl?.shadowRoot) return null;
    return hostEl.shadowRoot.querySelector(shadowSelector.inner);
  }
  return doc.querySelector(selector);
}

function extractValue(doc, selector, shadowSelector) {
  const el = queryInDocument(doc, selector, shadowSelector);
  if (el) {
    const raw = (el.textContent ?? "").trim();
    if (raw) return raw;
  }
  for (const frame of doc.querySelectorAll("iframe")) {
    try {
      const child = frame.contentDocument;
      if (child) {
        const nested = extractValue(child, selector, shadowSelector);
        if (nested) return nested;
      }
    } catch {
      /* cross-origin */
    }
  }
  return null;
}

async function waitForValue(doc, selector, shadowSelector, maxMs = 15000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const raw = extractValue(doc, selector, shadowSelector);
    if (raw) return raw;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

function loadUrlInIframe(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Iframe load timeout"));
    }, 25000);

    iframe.onload = () => {
      clearTimeout(timeout);
      try {
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        if (!doc) {
          reject(
            new Error(
              "Cannot access iframe document (X-Frame-Options or CSP may block framing)"
            )
          );
          return;
        }
        resolve(doc);
      } catch (err) {
        reject(
          new Error(
            "Cross-origin frame blocked: " +
              (err.message || "X-Frame-Options restriction")
          )
        );
      }
    };

    iframe.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("Iframe failed to load"));
    };

    iframe.src = url;
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "OFFSCREEN_PING") {
    sendResponse({ ready: true });
    return false;
  }

  if (message.type === "OFFSCREEN_PARSE_HTML") {
    const { html, selector, shadowSelector } = message.payload ?? {};
    try {
      const extraction = extractFromHtml(html, { selector, shadowSelector });
      sendResponse({ success: true, data: extraction });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return false;
  }

  if (message.type !== "OFFSCREEN_FETCH") return false;

  const { url, selector, shadowSelector } = message.payload ?? {};

  (async () => {
    try {
      const doc = await loadUrlInIframe(url);
      const raw = await waitForValue(doc, selector, shadowSelector, 15000);
      if (raw === null) {
        sendResponse({
          success: false,
          error: "Selector not found in offscreen document",
          ok: false
        });
        return;
      }
      sendResponse({
        success: true,
        data: { ok: true, raw, status: 200 },
        ok: true,
        raw
      });
    } catch (err) {
      sendResponse({
        success: false,
        error: err.message,
        ok: false
      });
    }
  })();

  return true;
});
