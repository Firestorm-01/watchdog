import { MessageTypes, sendMessage } from "../utils/messages.js";
import { formatNormalizedForDisplay } from "../utils/normalizer.js";

const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".panel");
const trackersList = document.getElementById("trackers-full-list");
const settingsForm = document.getElementById("settings-form");
const logViewer = document.getElementById("log-viewer");
const logLevelFilter = document.getElementById("log-level-filter");
const logTrackerFilter = document.getElementById("log-tracker-filter");
const storageUsage = document.getElementById("storage-usage");
const metricsSelect = document.getElementById("metrics-tracker-select");
const metricsViewer = document.getElementById("metrics-viewer");

let allLogs = [];
let metricsIndex = {};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    panels.forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document
      .getElementById(`panel-${tab.dataset.tab}`)
      .classList.add("active");
    if (tab.dataset.tab === "debug") loadDebug();
    if (tab.dataset.tab === "trackers") loadTrackers();
  });
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function loadTrackers() {
  const trackers = await sendMessage(MessageTypes.GET_ALL_TRACKERS);
  if (trackers.length === 0) {
    trackersList.innerHTML = "<p class='meta'>No trackers configured.</p>";
    return;
  }

  const cards = await Promise.all(
    trackers.map(async (t) => {
      const [history, metrics] = await Promise.all([
        sendMessage(MessageTypes.GET_TRACKER_HISTORY, { trackerId: t.id }),
        sendMessage(MessageTypes.GET_TRACKER_METRICS, { trackerId: t.id })
      ]);
      const display = formatNormalizedForDisplay(
        t.lastNormalized,
        t.valueType
      );
      const historyHtml =
        history.length === 0
          ? "<p class='meta'>No history yet.</p>"
          : `<ul class="history-list">${history
              .slice()
              .reverse()
              .map(
                (h) =>
                  `<li>${escapeHtml(h.ts)}: ${escapeHtml(String(h.oldValue ?? "—"))} → ${escapeHtml(String(h.newValue ?? "—"))}</li>`
              )
              .join("")}</ul>`;

      const metricsHtml = metrics
        ? `<pre class="metrics-inline">${escapeHtml(JSON.stringify(metrics, null, 2))}</pre>`
        : "<p class='meta'>No metrics yet (run a check).</p>";

      return `
        <details class="tracker-card">
          <summary>
            <span>${escapeHtml(t.label)}</span>
            <span class="meta">${t.status} · ${escapeHtml(String(display))}</span>
          </summary>
          <div class="card-body">
            <p class="meta">URL: ${escapeHtml(t.url)}</p>
            <p class="meta">Selector: ${escapeHtml(t.selector)}</p>
            <p class="meta">Interval: ${t.intervalMinutes}m · Checks: ${t.totalChecks} · Changes: ${t.totalChanges}</p>
            <p class="meta"><strong>Health</strong></p>
            ${metricsHtml}
            <p class="meta"><strong>History</strong></p>
            ${historyHtml}
          </div>
        </details>
      `;
    })
  );
  trackersList.innerHTML = cards.join("");
}

document.getElementById("btn-export").addEventListener("click", async () => {
  try {
    const data = await sendMessage(MessageTypes.EXPORT_TRACKERS);
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `watchdog-trackers-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export failed: " + err.message);
  }
});

document.getElementById("btn-import").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    alert("Import file too large (max 2 MB).");
    e.target.value = "";
    return;
  }
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!Array.isArray(imported)) throw new Error("Expected array of trackers");
    const result = await sendMessage(MessageTypes.IMPORT_TRACKERS, {
      trackers: imported
    });
    alert(`Imported ${result.imported} tracker(s).`);
    loadTrackers();
  } catch (err) {
    alert("Import failed: " + err.message);
  }
  e.target.value = "";
});

async function loadSettings() {
  const s = await sendMessage(MessageTypes.GET_SETTINGS);
  document.getElementById("default-interval").value =
    s.defaultIntervalMinutes ?? 15;
  document.getElementById("domain-interval").value = Math.round(
    (s.domainMinIntervalMs ?? 10000) / 1000
  );
  document.getElementById("renotify-minutes").value =
    s.defaultRenotifyAfterMinutes ?? 0;
  document.getElementById("notifications-enabled").checked =
    s.notificationsEnabled !== false;
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = settingsForm.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const interval = parseInt(
      document.getElementById("default-interval").value,
      10
    );
    const domainSec = parseInt(
      document.getElementById("domain-interval").value,
      10
    );
    if (interval < 5 || interval > 1440) {
      alert("Default interval must be 5–1440 minutes.");
      return;
    }
    if (domainSec < 1 || domainSec > 120) {
      alert("Domain throttle must be 1–120 seconds.");
      return;
    }
    await sendMessage(MessageTypes.UPDATE_SETTINGS, {
      defaultIntervalMinutes: interval,
      domainMinIntervalMs: domainSec * 1000,
      defaultRenotifyAfterMinutes: parseInt(
        document.getElementById("renotify-minutes").value,
        10
      ),
      notificationsEnabled: document.getElementById("notifications-enabled")
        .checked
    });
    alert("Settings saved.");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

function renderLogs() {
  const level = logLevelFilter.value;
  const trackerId = logTrackerFilter.value.trim();
  const filtered = allLogs.filter((l) => {
    if (level && l.level !== level) return false;
    if (trackerId && l.context?.trackerId !== trackerId) return false;
    return true;
  });
  logViewer.textContent =
    filtered.length === 0
      ? "No log entries."
      : filtered
          .slice()
          .reverse()
          .map(
            (l) =>
              `[${l.ts}] ${l.level.toUpperCase()}: ${l.message}${l.context && Object.keys(l.context).length ? " " + JSON.stringify(l.context) : ""}`
          )
          .join("\n");
}

async function loadMetricsDropdown() {
  const entries = await sendMessage(MessageTypes.GET_ALL_METRICS);
  metricsIndex = {};
  metricsSelect.innerHTML = '<option value="">Select a tracker…</option>';
  for (const entry of entries) {
    metricsIndex[entry.trackerId] = entry.metrics;
    const opt = document.createElement("option");
    opt.value = entry.trackerId;
    opt.textContent = entry.label;
    metricsSelect.appendChild(opt);
  }
}

function showSelectedMetrics() {
  const id = metricsSelect.value;
  if (!id) {
    metricsViewer.textContent = "No tracker selected.";
    return;
  }
  const m = metricsIndex[id];
  metricsViewer.textContent = m
    ? JSON.stringify(m, null, 2)
    : "No metrics yet — use “Check now” in the popup.";
}

metricsSelect.addEventListener("change", showSelectedMetrics);

async function loadDebug() {
  allLogs = await sendMessage(MessageTypes.GET_LOGS);
  renderLogs();
  await loadMetricsDropdown();
  showSelectedMetrics();
  const bytes = await chrome.storage.local.getBytesInUse();
  const max = 10485760;
  storageUsage.textContent = `Storage: ${(bytes / 1024).toFixed(1)} KB / ${(max / 1024 / 1024).toFixed(0)} MB (${((bytes / max) * 100).toFixed(1)}%)`;
}

logLevelFilter.addEventListener("change", renderLogs);
logTrackerFilter.addEventListener("input", renderLogs);

document.getElementById("btn-copy-logs").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(allLogs, null, 2));
    alert("Logs copied to clipboard.");
  } catch (err) {
    alert("Could not copy: " + err.message);
  }
});

document.getElementById("btn-clear-logs").addEventListener("click", async () => {
  if (!confirm("Clear all logs?")) return;
  await sendMessage(MessageTypes.CLEAR_LOGS);
  allLogs = [];
  renderLogs();
});

loadSettings();
loadTrackers();
