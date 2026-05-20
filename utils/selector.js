function buildAncestorPath(element) {
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let part = current.tagName.toLowerCase();
    if (current.id) {
      const idSel = `#${CSS.escape(current.id)}`;
      if (document.querySelectorAll(idSel).length === 1) {
        parts.unshift(idSel);
        break;
      }
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current.tagName
      );
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        part += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(part);
    current = current.parentElement;
    const full = parts.join(" > ");
    try {
      if (document.querySelectorAll(full).length === 1) break;
    } catch {
      break;
    }
  }
  return parts.join(" > ");
}

export function generateSelector(element) {
  if (!element || element.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  if (element.dataset?.testid) {
    return `[data-testid="${CSS.escape(element.dataset.testid)}"]`;
  }

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) {
    return `[aria-label="${CSS.escape(ariaLabel)}"]`;
  }

  if (element.id) {
    const idSel = `#${CSS.escape(element.id)}`;
    if (document.querySelectorAll(idSel).length === 1) {
      return idSel;
    }
  }

  if (element.classList?.length > 0) {
    const selector =
      "." + [...element.classList].map((c) => CSS.escape(c)).join(".");
    try {
      if (document.querySelectorAll(selector).length === 1) {
        return selector;
      }
    } catch {
      /* invalid selector from classes */
    }
  }

  return buildAncestorPath(element);
}

export function getShadowInfo(element) {
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) {
    const host = root.host;
    return {
      host: generateSelector(host),
      inner: generateSelector(element),
      isShadow: true
    };
  }
  return { isShadow: false };
}

export function queryElement(doc, selector, shadowSelector) {
  if (shadowSelector?.host && shadowSelector?.inner) {
    const hostEl = doc.querySelector(shadowSelector.host);
    if (!hostEl?.shadowRoot) return null;
    return hostEl.shadowRoot.querySelector(shadowSelector.inner);
  }
  return doc.querySelector(selector);
}
