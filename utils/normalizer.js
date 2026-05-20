export function extractRawValue(element) {
  if (!element) return "";
  return (element.textContent ?? "").trim();
}

export function detectType(raw) {
  if (/[$€£¥₹₩]/.test(raw) || /^\d[\d,. ]+$/.test(raw.trim())) {
    return "price";
  }
  const availabilityTerms =
    /in stock|out of stock|available|unavailable|sold out|add to cart/i;
  if (availabilityTerms.test(raw)) {
    return "availability";
  }
  if (/^[\d,. ]+$/.test(raw.trim())) {
    return "numeric";
  }
  return "text";
}

function parseNumberToken(token) {
  let cleaned = token.replace(/[$€£¥₹₩\s]/g, "");
  const lastDot = cleaned.lastIndexOf(".");
  const lastComma = cleaned.lastIndexOf(",");
  if (lastDot > lastComma) {
    cleaned = cleaned.replace(/,/g, "");
  } else if (lastComma > lastDot) {
    cleaned = cleaned.replace(/\./g, "").replace(",", ".");
  }
  const match = cleaned.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

export function normalize(raw, type) {
  switch (type) {
    case "price":
    case "numeric": {
      const tokens = raw.match(/\d[\d,.]*\d|\d[\d,.]*|\d/g) ?? [];
      const values = tokens
        .map((t) => parseNumberToken(t))
        .filter((n) => n != null && !Number.isNaN(n));
      if (values.length > 1) {
        return Math.max(...values);
      }
      if (values.length === 1) {
        return values[0];
      }
      return parseNumberToken(raw);
    }
    case "availability": {
      const lower = raw.toLowerCase();
      if (/in stock|available|add to cart/.test(lower)) return "available";
      if (/out of stock|unavailable|sold out/.test(lower)) return "unavailable";
      return lower.trim();
    }
    default:
      return raw.toLowerCase().trim();
  }
}

export function evaluateCondition(condition, oldNormalized, newNormalized) {
  if (!condition) {
    return oldNormalized !== newNormalized && oldNormalized != null;
  }
  switch (condition.type) {
    case "drops_below":
      return (
        typeof newNormalized === "number" &&
        typeof condition.value === "number" &&
        newNormalized < condition.value
      );
    case "rises_above":
      return (
        typeof newNormalized === "number" &&
        typeof condition.value === "number" &&
        newNormalized > condition.value
      );
    case "contains":
      return String(newNormalized).includes(String(condition.value));
    case "becomes_available":
      return (
        oldNormalized === "unavailable" && newNormalized === "available"
      );
    case "changes":
      return oldNormalized !== newNormalized;
    default:
      return oldNormalized !== newNormalized;
  }
}

export function formatNormalizedForDisplay(value, type) {
  if (value == null) return "—";
  if (type === "price" || type === "numeric") {
    return typeof value === "number" ? value.toLocaleString() : String(value);
  }
  return String(value);
}
