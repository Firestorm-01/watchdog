import { storage } from "./storage.js";

export function buildHealthMetrics(tracker, result, durationMs) {
  return {
    trackerId: tracker.id,
    lastCheckDurationMs: Math.round(durationMs),
    lastCheckSuccess: !!result?.success,
    lastHttpStatus: result?.status ?? null,
    lastFailureReason: result?.reason ?? result?.error ?? null,
    consecutiveFailures: tracker.consecutiveFailures ?? 0,
    consecutiveSuccesses: tracker.consecutiveSuccesses ?? 0,
    selectorMisses: tracker.selectorMisses ?? 0,
    renderMode: tracker.renderMode ?? "static",
    status: tracker.status,
    totalChecks: tracker.totalChecks ?? 0,
    totalChanges: tracker.totalChanges ?? 0,
    updatedAt: new Date().toISOString()
  };
}

export async function recordHealthMetrics(tracker, result, durationMs) {
  const metrics = buildHealthMetrics(tracker, result, durationMs);
  await storage.setMetrics(tracker.id, metrics);
  return metrics;
}

export async function getAllMetrics() {
  const trackers = await storage.getAllTrackers();
  const entries = await Promise.all(
    trackers.map(async (t) => ({
      trackerId: t.id,
      label: t.label,
      metrics: (await storage.getMetrics(t.id)) ?? null
    }))
  );
  return entries;
}
