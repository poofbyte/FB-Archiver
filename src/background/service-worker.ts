import type {
  ExtensionMessage,
  MessageResponse,
  MediaItem,
  Settings,
  ProgressInfo,
} from "../types";
import { DownloadQueue } from "../services/download-queue";
import { ZipPackager } from "../services/zip-packager";
import { ProgressTracker } from "../services/progress-tracker";
import { ResumeManager } from "../services/resume-manager";
import { db } from "../storage/indexeddb";
import { exportMetadata, downloadExport } from "../utils/export";
import { logger } from "../utils/logger";

/* ── Global State ──────────────────────────────────────────────────────────── */

let downloadQueue: DownloadQueue;
let zipPackager: ZipPackager;
const progressTracker = new ProgressTracker();
const resumeManager = new ResumeManager();
let currentTabId: number | null = null;
let initReady: Promise<void> | null = null;
let currentSettings: Settings = {
  scrollSpeed: 400,
  concurrentDownloads: 3,
  retryCount: 5,
  maxMediaCount: 0,
  autoResume: true,
  autoExport: true,
  autoZip: true,
  zipSuffixPhotos: "_photos",
  zipSuffixVideos: "_videos",
  downloadLocation: "",
};

/* ── Initialization ────────────────────────────────────────────────────────── */

async function init(): Promise<void> {
  logger.info("Background service worker initializing...");

  // Initialize database
  await db.init();

  // Load settings
  currentSettings = await db.getSettings();
  logger.info("Settings loaded", currentSettings);

  // Initialize download queue
  downloadQueue = new DownloadQueue({
    maxConcurrent: currentSettings.concurrentDownloads,
    maxRetries: currentSettings.retryCount,
    onUpdate: () => broadcastProgress(),
  });
  downloadQueue.init();

  // Initialize ZIP packager
  zipPackager = new ZipPackager(currentSettings);

  // Set up message listener
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, sender, sendResponse) => {
      if (sender.tab) {
        currentTabId = sender.tab.id ?? null;
      }
      handleMessage(message, sender)
        .then(sendResponse)
        .catch((err) => {
          sendResponse({ success: false, error: String(err) });
        });
      return true; // async response
    }
  );

  // Set up download completion listener for auto-zip
  progressTracker.onUpdate(async (info) => {
    // When all downloads complete, trigger ZIP packaging
    if (
      info.totalFound > 0 &&
      info.totalRemaining === 0 &&
      info.totalFailed === 0 &&
      info.totalDownloaded > 0 &&
      !info.isDownloading
    ) {
      logger.info("All downloads complete, packaging ZIPs...");
      await packageZips();
    }
  });

  // Check for auto-resume on startup
  if (currentSettings.autoResume) {
    const lastSession = await resumeManager.getLastSession();
    if (lastSession && lastSession.isRunning) {
      logger.info("Found resumable session", lastSession);
      // Restore state
      progressTracker.setFound(
        lastSession.totalFound,
        0, // Will be recalculated
        0
      );
    }
  }

  logger.info("Background service worker initialized");
}

/* ── Message Handling ──────────────────────────────────────────────────────── */

async function handleMessage(
  message: ExtensionMessage,
  sender?: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  switch (message.action) {
    case "START_SCAN":
      return handleStartScan(message.payload as Settings, sender);

    case "STOP_SCAN":
      return handleStopScan();

    case "PAUSE_SCAN":
      return handlePauseScan();

    case "RESUME_SCAN":
      return handleResumeScan();

    case "START_DOWNLOAD":
      return handleStartDownload(message.payload as MediaItem[]);

    case "PAUSE_DOWNLOAD":
      return handlePauseDownload();

    case "RESUME_DOWNLOAD":
      return handleResumeDownload();

    case "CANCEL_DOWNLOAD":
      return handleCancelDownload();

    case "GET_PROGRESS":
      return { success: true, data: progressTracker.getProgress() };

    case "GET_MEDIA":
      return handleGetMedia();

    case "EXPORT_METADATA":
      return handleExport(message.payload as { format: "json" | "csv" });

    case "CLEAR_DATABASE":
      return handleClearDatabase();

    case "SETTINGS_CHANGED":
      return handleSettingsChanged(message.payload as Settings);

    case "SCAN_COMPLETE":
      return handleScanComplete(message.payload as {
        total: number;
        photos: number;
        videos: number;
        media: MediaItem[];
      });

    case "MEDIA_FOUND":
      return handleMediaFound(message.payload as ProgressInfo);

    default:
      return { success: false, error: `Unknown action: ${message.action}` };
  }
}

/* ── Action Handlers ───────────────────────────────────────────────────────── */

async function handleStartScan(
  settings?: Settings,
  sender?: chrome.runtime.MessageSender
): Promise<MessageResponse> {
  if (settings) {
    currentSettings = settings;
    await db.saveSettings(currentSettings);
    downloadQueue = new DownloadQueue({
      maxConcurrent: currentSettings.concurrentDownloads,
      maxRetries: currentSettings.retryCount,
      onUpdate: () => broadcastProgress(),
    });
    downloadQueue.init();
    zipPackager.updateSettings(currentSettings);
  }

  progressTracker.reset();
  progressTracker.setRunning(true);

  // Get active tab
  const tabId = sender?.tab?.id ?? currentTabId;
  if (!tabId) {
    return { success: false, error: "No active tab found" };
  }

  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      action: "START_SCAN",
      payload: currentSettings,
    });
    return response;
  } catch (err) {
    logger.error("Failed to start scan", err);
    return { success: false, error: `Failed to communicate with tab: ${err}` };
  }
}

async function handleStopScan(): Promise<MessageResponse> {
  progressTracker.setRunning(false);
  progressTracker.setPaused(false);

  const tabId = currentTabId;
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "STOP_SCAN" });
    } catch {
      // Tab may be closed
    }
  }

  return { success: true };
}

function handlePauseScan(): MessageResponse {
  progressTracker.setPaused(true);
  const tabId = currentTabId;
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "PAUSE_SCAN" }).catch(() => {});
  }
  return { success: true };
}

function handleResumeScan(): MessageResponse {
  progressTracker.setPaused(false);
  const tabId = currentTabId;
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "RESUME_SCAN" }).catch(() => {});
  }
  return { success: true };
}

async function handleStartDownload(mediaItems: MediaItem[]): Promise<MessageResponse> {
  if (!mediaItems || mediaItems.length === 0) {
    // Fetch from DB
    const allMedia = await db.getAllMedia();
    mediaItems = allMedia.filter((m) => !m.downloaded);
  }

  if (mediaItems.length === 0) {
    return { success: false, error: "No media to download" };
  }

  // Save media to DB
  await db.addMediaBatch(mediaItems);

  // Enqueue downloads
  await downloadQueue.enqueue(mediaItems);
  progressTracker.setDownloading(true);

  // Start processing
  await downloadQueue.start();

  return {
    success: true,
    data: { queued: mediaItems.length },
  };
}

async function handlePauseDownload(): Promise<MessageResponse> {
  await downloadQueue.pause();
  progressTracker.setPaused(true);
  return { success: true };
}

async function handleResumeDownload(): Promise<MessageResponse> {
  await downloadQueue.resume();
  progressTracker.setPaused(false);
  progressTracker.setDownloading(true);
  return { success: true };
}

async function handleCancelDownload(): Promise<MessageResponse> {
  await downloadQueue.cancel();
  progressTracker.setDownloading(false);
  return { success: true };
}

async function handleGetMedia(): Promise<MessageResponse> {
  const media = await db.getAllMedia();
  return { success: true, data: media };
}

async function handleExport(options: {
  format: "json" | "csv";
}): Promise<MessageResponse> {
  try {
    const media = await db.getAllMedia();
    const content = exportMetadata(media, options.format);
    await downloadExport(content, options.format);
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function handleClearDatabase(): Promise<MessageResponse> {
  await db.clearAll();
  progressTracker.reset();
  return { success: true };
}

async function handleSettingsChanged(settings: Settings): Promise<MessageResponse> {
  currentSettings = settings;
  await db.saveSettings(settings);

  // Update download queue config
  downloadQueue = new DownloadQueue({
    maxConcurrent: settings.concurrentDownloads,
    maxRetries: settings.retryCount,
    onUpdate: () => broadcastProgress(),
  });
  downloadQueue.init();

  zipPackager.updateSettings(settings);
  return { success: true };
}

function handleScanComplete(payload: {
  total: number;
  photos: number;
  videos: number;
  media: MediaItem[];
}): MessageResponse {
  progressTracker.setFound(payload.total, payload.photos, payload.videos);
  progressTracker.setRunning(false);

  // Notify popup
  broadcastProgress();

  return { success: true };
}

function handleMediaFound(payload: ProgressInfo): MessageResponse {
  progressTracker.setFound(
    payload.totalFound,
    payload.photosFound,
    payload.videosFound
  );
  broadcastProgress();
  return { success: true };
}

/* ── ZIP Packaging ─────────────────────────────────────────────────────────── */

async function packageZips(): Promise<void> {
  try {
    progressTracker.setDownloading(false);
    const result = await zipPackager.packageAll();
    logger.info("ZIP packaging complete", result);

    // Auto-export metadata
    if (currentSettings.autoExport) {
      const media = await db.getAllMedia();
      const json = exportMetadata(media, "json");
      await downloadExport(json, "json");
    }

    broadcastProgress();
  } catch (err) {
    logger.error("ZIP packaging failed", err);
  }
}

/* ── Broadcast ─────────────────────────────────────────────────────────────── */

async function broadcastProgress(): Promise<void> {
  const info = progressTracker.getProgress();
  const queueStats = downloadQueue?.getStats();

  const combinedInfo = {
    ...info,
    queue: queueStats,
  };

  try {
    // Send to popup
    await chrome.runtime.sendMessage({
      action: "DOWNLOAD_PROGRESS",
      payload: combinedInfo,
    });
  } catch {
    // Popup may not be open
  }

  // Update badge
  if (info.totalRemaining > 0) {
    chrome.action.setBadgeText({ text: String(info.totalRemaining) });
    chrome.action.setBadgeBackgroundColor({ color: "#4285f4" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

/* ── Tab Management ────────────────────────────────────────────────────────── */

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  currentTabId = activeInfo.tabId;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.includes("facebook.com")) {
      logger.debug(`Switched to Facebook tab: ${tab.url}`);
    }
  } catch {
    // Tab may not exist
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === currentTabId && changeInfo.url) {
    logger.debug(`Tab URL changed: ${changeInfo.url}`);
  }
});

/* ── Lifecycle ─────────────────────────────────────────────────────────────── */

chrome.runtime.onInstalled.addListener(async (details) => {
  if (initReady) await initReady;
  if (details.reason === "install") {
    logger.info("Extension installed for the first time");
    await db.saveSettings(currentSettings);
  } else if (details.reason === "update") {
    logger.info(`Extension updated to version ${chrome.runtime.getManifest().version}`);
  }
});

// Initialize
initReady = init().catch((err) => {
  logger.error("Failed to initialize background service worker", err);
});
