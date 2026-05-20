import { MessageTypes, sendMessage } from "../utils/messages.js";
import { formatNormalizedForDisplay } from "../utils/normalizer.js";

const trackerList = document.getElementById("tracker-list");
const emptyState = document.getElementById("empty-state");
const globalStatus = document.getElementById("global-status");
const addPanel = document.getElementById("add-panel");
const addForm = document.getElementById("add-form");
const btnAdd = document.getElementById("btn-add");
const btnPick = document.getElementById("btn-pick");
const btnCancelAdd = document.getElementById("btn-cancel-add");
const toastEl = document.getElementById("toast");
const fieldLabel = document.getElementById("field-label");
const fieldUrl = document.getElementById("field-url");
const fieldSelector = document.getElementById("field-selector");
const fieldInterval = document.getElementById("field-interval");
const fieldRenotify = document.getElementById("field-renotify");
const fieldConditionType = document.getElementById("field-condition-type");
const fieldConditionValue = document.getElementById("field-condition-value");
const conditionValueWrap = document.getElementById("condition-value-wrap");
const fieldCookies = document.getElementById("field-cookies");
const pickPreview = document.getElementById("pick-preview");
const shadowWarning = document.getElementById("shadow-warning");

let trackers = [];
let historyCache = {};
let pendingShadowSelector = null;
let toastTimer = null;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast toast-${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add("hidden");
  }, 3500);
}

function relativeTime(iso) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDetectionTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

function statusBadge(tracker) {
  const map = {
    active: ["ACTIVE", "badge-active"],
    paused: ["PAUSED", "badge-paused"],
    error: ["ERROR", "badge-error"],
    needs_attention: ["ATTENTION", "badge-attention"]
  };
  const [text, cls] = map[tracker.status] ?? ["UNKNOWN", "badge-paused"];
  return `<span class="badge ${cls}">${text}</span>`;
}

function buildSparkline(values) {
  if (values.length < 2) return "";
  const w = 120;
  const h = 24;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - min) / range) * h;
      return `${x},${y}`;
    })
    .join(" ");
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="#22c55e" stroke-width="1.5" points="${points}"/></svg>`;
}

async function loadHistory(trackerId) {
  if (historyCache[trackerId]) return historyCache[trackerId];
  try {
    const history = await sendMessage(MessageTypes.GET_TRACKER_HISTORY, {
      trackerId
    });
    historyCache[trackerId] = history;
    return history;
  } catch {
    return [];
  }
}

async function getSparklineValues(tracker, history) {
  const vals = history
    .map((h) => h.newNormalized)
    .filter((v) => typeof v === "number");
  if (typeof tracker.lastNormalized === "number") {
    vals.push(tracker.lastNormalized);
  }
  return vals.slice(-20);
}

function renderValue(tracker, lastHistory) {
  const current =
    tracker.lastValue ??
    formatNormalizedForDisplay(tracker.lastNormalized, tracker.valueType);
  let html = `<p class="tracker-value">${escapeHtml(String(current))}</p>`;
  if (lastHistory) {
    const oldDisp = formatNormalizedForDisplay(
      lastHistory.oldNormalized,
      tracker.valueType
    );
    const newDisp = formatNormalizedForDisplay(
      lastHistory.newNormalized,
      tracker.valueType
    );
    const detected = formatDetectionTime(lastHistory.ts);
    html += `<p class="value-change-meta">Last change: ${escapeHtml(oldDisp)} → ${escapeHtml(newDisp)}${detected ? ` · ${escapeHtml(detected)}` : ""}</p>`;
  }
  return html;
}

async function renderTrackers() {
  const active = trackers.filter((t) => t.status === "active").length;
  const paused = trackers.filter((t) => t.status === "paused").length;
  const attention = trackers.filter(
    (t) => t.status === "needs_attention" || t.status === "error"
  ).length;
  globalStatus.textContent = `${active} active · ${paused} paused${attention ? ` · ${attention} need attention` : ""}`;

  if (trackers.length === 0) {
    emptyState.classList.remove("hidden");
    trackerList.innerHTML = "";
    return;
  }

  emptyState.classList.add("hidden");
  const rows = [];
  for (const t of trackers) {
    const history = await loadHistory(t.id);
    const lastChange = history[history.length - 1];
    let spark = "";
    if (t.valueType === "price" || t.valueType === "numeric") {
      const vals = await getSparklineValues(t, history);
      spark = buildSparkline(vals);
    }
    rows.push(`
      <article class="tracker-row" data-id="${t.id}">
        <div class="tracker-header">
          <span class="tracker-label" title="${escapeHtml(t.label)}">${escapeHtml(t.label)}</span>
          ${statusBadge(t)}
        </div>
        ${renderValue(t, lastChange)}
        ${spark}
        <p class="tracker-meta">Checked ${relativeTime(t.lastChecked)}${t.errorMessage ? ` · ${escapeHtml(t.errorMessage)}` : ""}</p>
        <div class="tracker-actions">
          ${t.status === "active" ? `<button data-action="pause" data-id="${t.id}">Pause</button>` : `<button data-action="resume" data-id="${t.id}">Resume</button>`}
          <button data-action="check" data-id="${t.id}">Check now</button>
          <button class="btn-delete" data-action="delete" data-id="${t.id}">Delete</button>
        </div>
      </article>
    `);
  }
  trackerList.innerHTML = rows.join("");
}

async function refresh() {
  try {
    trackers = await sendMessage(MessageTypes.GET_ALL_TRACKERS);
    historyCache = {};
    await renderTrackers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function showAddPanel(show) {
  addPanel.classList.toggle("hidden", !show);
  if (!show) {
    addForm.reset();
    pendingShadowSelector = null;
    shadowWarning.classList.add("hidden");
  }
}

function applyPickSession(session) {
  if (!session || session.status !== "complete") return;
  if (session.status === "error") {
    showToast(session.error || "Pick session failed", "error");
    return;
  }
  fieldUrl.value = session.url ?? "";
  fieldSelector.value = session.selector ?? "";
  pendingShadowSelector = session.shadowSelector ?? null;
  pickPreview.textContent = session.preview
    ? `Preview: "${session.preview}"`
    : "";
  if (session.shadowWarning || session.shadowSelector) {
    shadowWarning.textContent =
      "This element is inside a Shadow DOM. Tracking may be unreliable across page updates.";
    shadowWarning.classList.remove("hidden");
  } else {
    shadowWarning.classList.add("hidden");
  }
  if (!fieldLabel.value && session.preview) {
    fieldLabel.value = session.preview.slice(0, 40);
  }
  showAddPanel(true);
}

async function startPick() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showToast("No active tab found.", "error");
    return;
  }
  const url = tab.url ?? "";
  if (!/^https?:\/\//i.test(url)) {
    showToast("Open a normal website (http/https) before picking.", "error");
    return;
  }
  try {
    const sessionId = crypto.randomUUID();
    await sendMessage(MessageTypes.START_PICK_SESSION, {
      tabId: tab.id,
      sessionId
    });
    window.close();
  } catch (err) {
    showToast(err.message, "error");
  }
}

fieldConditionType.addEventListener("change", () => {
  const needsValue = ["drops_below", "rises_above", "contains"].includes(
    fieldConditionType.value
  );
  conditionValueWrap.classList.toggle("hidden", !needsValue);
});

btnAdd.addEventListener("click", () => showAddPanel(true));
btnCancelAdd.addEventListener("click", () => showAddPanel(false));
btnPick.addEventListener("click", startPick);

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const submitBtn = addForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const conditionType = fieldConditionType.value;
  let condition = null;
  if (conditionType) {
    let value = fieldConditionValue.value;
    if (["drops_below", "rises_above"].includes(conditionType)) {
      value = parseFloat(value);
      if (Number.isNaN(value)) {
        showToast("Enter a valid number for the threshold.", "error");
        submitBtn.disabled = false;
        return;
      }
    }
    condition = { type: conditionType, value };
  }

  try {
    await sendMessage(MessageTypes.CREATE_TRACKER, {
      label: fieldLabel.value.trim(),
      url: fieldUrl.value.trim(),
      selector: fieldSelector.value.trim(),
      shadowSelector: pendingShadowSelector,
      intervalMinutes: parseInt(fieldInterval.value, 10) || 15,
      renotifyAfterMinutes: parseInt(fieldRenotify.value, 10) || 0,
      condition,
      requiresCookies: fieldCookies.checked
    });
    await chrome.storage.local.remove("pickSession");
    showAddPanel(false);
    showToast("Tracker saved", "success");
    await refresh();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    submitBtn.disabled = false;
  }
});

trackerList.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const { action, id } = btn.dataset;
  const row = btn.closest(".tracker-row");
  btn.disabled = true;
  if (row) row.classList.add("checking");

  try {
    if (action === "pause") {
      await sendMessage(MessageTypes.PAUSE_TRACKER, { id });
      showToast("Tracker paused", "info");
    } else if (action === "resume") {
      await sendMessage(MessageTypes.RESUME_TRACKER, { id });
      showToast("Tracker resumed", "success");
    } else if (action === "check") {
      await sendMessage(MessageTypes.CHECK_NOW, { id });
      showToast("Check complete", "success");
    } else if (action === "delete") {
      if (confirm("Delete this tracker?")) {
        await sendMessage(MessageTypes.DELETE_TRACKER, { id });
        showToast("Tracker deleted", "info");
      }
    }
    await refresh();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    if (row) row.classList.remove("checking");
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.trackers) {
    trackers = changes.trackers.newValue ?? [];
    renderTrackers();
  }
  if (changes.pickSession?.newValue) {
    applyPickSession(changes.pickSession.newValue);
  }
});

(async () => {
  try {
    const settings = await sendMessage(MessageTypes.GET_SETTINGS);
    fieldInterval.value = settings.defaultIntervalMinutes ?? 15;
    fieldRenotify.value = settings.defaultRenotifyAfterMinutes ?? 0;
  } catch {
    /* ignore */
  }
  await refresh();
  const { pickSession } = await chrome.storage.local.get("pickSession");
  if (pickSession?.status === "complete") {
    applyPickSession(pickSession);
  } else if (pickSession?.status === "error") {
    showToast(pickSession.error, "error");
  }
})();
