export const MessageTypes = {
  GET_ALL_TRACKERS: "GET_ALL_TRACKERS",
  START_PICK_SESSION: "START_PICK_SESSION",
  CANCEL_PICK_SESSION: "CANCEL_PICK_SESSION",
  CHECK_NOW: "CHECK_NOW",
  PAUSE_TRACKER: "PAUSE_TRACKER",
  RESUME_TRACKER: "RESUME_TRACKER",
  DELETE_TRACKER: "DELETE_TRACKER",
  CREATE_TRACKER: "CREATE_TRACKER",
  PICK_COMPLETE: "PICK_COMPLETE",
  PICK_CANCELLED: "PICK_CANCELLED",
  OFFSCREEN_FETCH: "OFFSCREEN_FETCH",
  GET_SETTINGS: "GET_SETTINGS",
  UPDATE_SETTINGS: "UPDATE_SETTINGS",
  GET_LOGS: "GET_LOGS",
  CLEAR_LOGS: "CLEAR_LOGS",
  EXPORT_TRACKERS: "EXPORT_TRACKERS",
  IMPORT_TRACKERS: "IMPORT_TRACKERS",
  GET_TRACKER_HISTORY: "GET_TRACKER_HISTORY",
  GET_TRACKER_METRICS: "GET_TRACKER_METRICS",
  GET_ALL_METRICS: "GET_ALL_METRICS"
};

export function createRequestId() {
  return crypto.randomUUID();
}

export function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const requestId = createRequestId();
    chrome.runtime.sendMessage(
      { type, payload, requestId },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error("No response from background"));
          return;
        }
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || "Unknown error"));
        }
      }
    );
  });
}
