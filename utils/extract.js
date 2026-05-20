import { queryElement } from "./selector.js";
import { extractRawValue } from "./normalizer.js";

function detectJsRendering(doc, selector) {
  const body = doc.body;
  if (!body) return { jsSignals: 0, elementFound: false };

  const element = queryElement(doc, selector, null);
  const textLen = (body.textContent ?? "").trim().length;

  let jsSignals = 0;
  if (textLen < 500) jsSignals++;
  const root = body.querySelector("#root, #app");
  if (root && root.children.length === 0) jsSignals++;
  const noscript = body.querySelector("noscript");
  if (
    noscript &&
    /javascript required|enable javascript|requires javascript/i.test(
      noscript.textContent ?? ""
    )
  ) {
    jsSignals++;
  }

  return { jsSignals, elementFound: !!element };
}

export function extractFromDocument(doc, tracker) {
  const element = queryElement(doc, tracker.selector, tracker.shadowSelector);
  if (!element) {
    const { jsSignals } = detectJsRendering(doc, tracker.selector);
    if (jsSignals >= 2) {
      return {
        ok: false,
        reason: "js-required",
        jsSignals
      };
    }
    return { ok: false, reason: "selectorMissing" };
  }
  const raw = extractRawValue(element);
  const { jsSignals } = detectJsRendering(doc, tracker.selector);
  return { ok: true, raw, elementFound: true, jsSignals };
}

export function extractFromHtml(html, tracker) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return extractFromDocument(doc, tracker);
}
