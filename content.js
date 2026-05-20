(function () {
  if (window.__watchdogPickerActive) return;

  const protocol = window.location.protocol;
  if (protocol !== "http:" && protocol !== "https:") {
    return;
  }

  window.__watchdogPickerActive = true;

  const OVERLAY_ID = "watchdog-picker-overlay";
  const HIGHLIGHT_CLASS = "watchdog-picker-highlight";

  let sessionId = null;
  let hoveredEl = null;

  const style = document.createElement("style");
  style.textContent = `
    .${HIGHLIGHT_CLASS} {
      outline: 2px solid #22c55e !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    #${OVERLAY_ID} {
      position: fixed;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #1a1a1a;
      color: #e5e5e5;
      padding: 8px 16px;
      border-radius: 6px;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      pointer-events: none;
    }
  `;
  document.documentElement.appendChild(style);

  const bannerEl = document.createElement("div");
  bannerEl.id = OVERLAY_ID;
  bannerEl.textContent =
    "WatchDog: Click an element to track · Esc to cancel";
  document.documentElement.appendChild(bannerEl);

  function generateSelector(element) {
    if (element.dataset?.testid) {
      return `[data-testid="${CSS.escape(element.dataset.testid)}"]`;
    }
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel) {
      return `[aria-label="${CSS.escape(ariaLabel)}"]`;
    }
    if (element.id) {
      const idSel = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(idSel).length === 1) return idSel;
    }
    if (element.classList?.length > 0) {
      const sel =
        "." + [...element.classList].map((c) => CSS.escape(c)).join(".");
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch {
        /* ignore */
      }
    }
    const parts = [];
    let current = element;
    while (
      current &&
      current.nodeType === Node.ELEMENT_NODE &&
      current !== document.body
    ) {
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (c) => c.tagName === current.tagName
        );
        if (siblings.length > 1) {
          part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
      }
      parts.unshift(part);
      current = current.parentElement;
      try {
        if (document.querySelectorAll(parts.join(" > ")).length === 1) break;
      } catch {
        break;
      }
    }
    return parts.join(" > ");
  }

  function getShadowInfo(element) {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot) {
      return {
        shadowSelector: {
          host: generateSelector(root.host),
          inner: generateSelector(element)
        },
        shadowWarning: true
      };
    }
    return { shadowSelector: null, shadowWarning: false };
  }

  function cleanup() {
    window.__watchdogPickerActive = false;
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("beforeunload", cleanup);
    document.removeEventListener("visibilitychange", onVisibility);
    if (hoveredEl) hoveredEl.classList.remove(HIGHLIGHT_CLASS);
    bannerEl.remove();
    style.remove();
  }

  function onVisibility() {
    if (document.visibilityState === "hidden") cleanup();
  }

  function onMouseMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === bannerEl || el === hoveredEl) return;
    if (hoveredEl) hoveredEl.classList.remove(HIGHLIGHT_CLASS);
    hoveredEl = el;
    hoveredEl.classList.add(HIGHLIGHT_CLASS);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    if (!el || el === bannerEl) return;

    const selector = generateSelector(el);
    const preview = (el.textContent ?? "").trim().slice(0, 120);
    const { shadowSelector, shadowWarning } = getShadowInfo(el);

    chrome.runtime.sendMessage({
      type: "PICK_COMPLETE",
      payload: {
        sessionId,
        selector,
        preview,
        shadowSelector,
        shadowWarning,
        url: window.location.href
      },
      requestId: crypto.randomUUID()
    });

    cleanup();
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      chrome.runtime.sendMessage({
        type: "PICK_CANCELLED",
        payload: { sessionId },
        requestId: crypto.randomUUID()
      });
      cleanup();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "PICK_CANCEL_EXTERNAL") {
      cleanup();
    }
  });

  chrome.storage.local.get("pickSession", (result) => {
    sessionId = result.pickSession?.sessionId ?? crypto.randomUUID();
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("beforeunload", cleanup);
    document.addEventListener("visibilitychange", onVisibility);
  });
})();
