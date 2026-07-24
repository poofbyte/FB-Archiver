import type { ProgressInfo, MediaItem } from "../types";
import { db } from "../storage/indexeddb";

/* ── DOM References ────────────────────────────────────────────────────────── */

const $ = (id: string) => document.getElementById(id)!;

const statusDot = $("status-dot");
const statusText = $("status-text");
const pageUrl = $("page-url");
const pageType = $("page-type");

const statTotal = $("stat-total");
const statPhotos = $("stat-photos");
const statVideos = $("stat-videos");
const statDownloaded = $("stat-downloaded");
const statRemaining = $("stat-remaining");
const statFailed = $("stat-failed");

const progressSection = $("progress-section");
const progressBar = $("progress-bar");
const progressPercent = $("progress-percent");
const progressEta = $("progress-eta");

const btnScan = $("btn-scan") as HTMLButtonElement;
const btnPause = $("btn-pause") as HTMLButtonElement;
const btnStop = $("btn-stop") as HTMLButtonElement;
const btnDownload = $("btn-download") as HTMLButtonElement;
const btnZip = $("btn-zip") as HTMLButtonElement;
const btnExport = $("btn-export") as HTMLButtonElement;
const btnClear = $("btn-clear") as HTMLButtonElement;
const settingsBtn = $("settings-btn") as HTMLButtonElement;

const scanControls = $("scan-controls");
const downloadControls = $("download-controls");
const queueInfo = $("queue-info");
const queueQueued = $("queue-queued");
const queueActive = $("queue-active");
const queueDone = $("queue-done");

/* ── State ─────────────────────────────────────────────────────────────────── */

let currentTabId: number | null = null;
let isScanning = false;
let isDownloading = false;
let mediaItems: MediaItem[] = [];
let progress: ProgressInfo | null = null;

/* ── Initialization ────────────────────────────────────────────────────────── */

async function init(): Promise<void> {
  await db.init();
  setupEventListeners();
  await detectCurrentTab();
  await restoreState();
}

function setupEventListeners(): void {
  btnScan.addEventListener("click", startScan);
  btnPause.addEventListener("click", pauseResume);
  btnStop.addEventListener("click", stopScan);
  btnDownload.addEventListener("click", startDownload);
  btnZip.addEventListener("click", packageZip);
  btnExport.addEventListener("click", exportMetadata);
  btnClear.addEventListener("click", clearDatabase);
  settingsBtn.addEventListener("click", openSettings);

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "DOWNLOAD_PROGRESS") {
      updateProgress(message.payload);
    }
    if (message.action === "SCAN_COMPLETE") {
      handleScanComplete(message.payload);
    }
  });
}

/* ── Tab Detection ─────────────────────────────────────────────────────────── */

async function detectCurrentTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    currentTabId = tab.id;

    if (tab.url?.includes("facebook.com")) {
      pageUrl.textContent = tab.url;

      // Detect page type
      const url = tab.url;
      if (/\/photos/.test(url)) {
        pageType.textContent = "Photos Page";
      } else if (/\/videos/.test(url)) {
        pageType.textContent = "Videos Page";
      } else if (/\/albums/.test(url)) {
        pageType.textContent = "Albums Page";
      } else if (/\/tagged/.test(url)) {
        pageType.textContent = "Tagged Photos";
      } else if (/\/reels/.test(url)) {
        pageType.textContent = "Reels";
      } else {
        pageType.textContent = "Facebook Page";
      }

      btnScan.disabled = false;
    } else {
      pageUrl.textContent = "Not on a Facebook page";
      pageType.textContent = "";
      btnScan.disabled = true;
    }
  } catch (err) {
    pageUrl.textContent = "Unable to detect page";
  }
}

/* ── Actions ───────────────────────────────────────────────────────────────── */

async function startScan(): Promise<void> {
  if (!currentTabId) return;

  isScanning = true;
  updateUI();

  setStatus("scanning", "Scanning page...");

  // Load settings
  const settings = await db.getSettings();

  try {
    const response = await chrome.tabs.sendMessage(currentTabId, {
      action: "START_SCAN",
      payload: settings,
    });

    if (!response?.success) {
      setStatus("error", response?.error || "Scan failed");
      isScanning = false;
      updateUI();
    }
  } catch (err) {
    setStatus("error", "Cannot communicate with page");
    isScanning = false;
    updateUI();
  }
}

async function stopScan(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ action: "STOP_SCAN" });
  } catch {
    // Ignore
  }

  if (currentTabId) {
    try {
      await chrome.tabs.sendMessage(currentTabId, { action: "STOP_SCAN" });
    } catch {
      // Ignore
    }
  }

  isScanning = false;
  updateUI();
}

function pauseResume(): void {
  if (progress?.isPaused) {
    chrome.runtime.sendMessage({ action: "RESUME_SCAN" });
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action: "RESUME_SCAN" }).catch(() => {});
    }
  } else {
    chrome.runtime.sendMessage({ action: "PAUSE_SCAN" });
    if (currentTabId) {
      chrome.tabs.sendMessage(currentTabId, { action: "PAUSE_SCAN" }).catch(() => {});
    }
  }
}

async function startDownload(): Promise<void> {
  isDownloading = true;
  updateUI();
  setStatus("downloading", "Starting downloads...");

  try {
    // Always send empty array — background fetches from DB for reliable source of truth
    const response = await chrome.runtime.sendMessage({
      action: "START_DOWNLOAD",
      payload: [],
    });

    if (response?.success) {
      const count = response.data?.queued ?? 0;
      if (count === 0) {
        setStatus("error", "No undownloaded media found in database");
        isDownloading = false;
        updateUI();
      } else {
        setStatus("downloading", `Downloading ${count} items...`);
      }
    } else {
      setStatus("error", response?.error || "Download failed");
      isDownloading = false;
      updateUI();
    }
  } catch (err) {
    setStatus("error", "Failed to start downloads");
    isDownloading = false;
    updateUI();
  }
}

async function packageZip(): Promise<void> {
  setStatus("scanning", "Packaging ZIP files...");

  try {
    const response = await chrome.runtime.sendMessage({
      action: "PACKAGE_ZIP",
    });

    if (response?.success) {
      setStatus("idle", "ZIP packaging started — check for download prompt");
    } else {
      setStatus("error", response?.error || "ZIP failed");
    }
  } catch {
    setStatus("error", "Failed to package ZIP");
  }
}

async function exportMetadata(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      action: "EXPORT_METADATA",
      payload: { format: "json" },
    });
    setStatus("idle", "Metadata exported");
  } catch {
    setStatus("error", "Export failed");
  }
}

async function clearDatabase(): Promise<void> {
  if (!confirm("Clear all archived data? This cannot be undone.")) return;

  try {
    await chrome.runtime.sendMessage({ action: "CLEAR_DATABASE" });
    mediaItems = [];
    progress = null;
    updateStats(0, 0, 0, 0, 0, 0);
    setStatus("idle", "Database cleared");
    updateUI();
  } catch {
    setStatus("error", "Failed to clear database");
  }
}

function openSettings(): void {
  chrome.runtime.openOptionsPage?.();
}

/* ── UI Updates ────────────────────────────────────────────────────────────── */

function updateUI(): void {
  // Scan controls
  scanControls.style.display = isScanning ? "flex" : "none";
  btnScan.style.display = isScanning ? "none" : "flex";

  // Pause button state
  if (progress?.isPaused) {
    btnPause.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
      Resume
    `;
  } else {
    btnPause.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      Pause
    `;
  }

  // Download controls
  downloadControls.style.display = mediaItems.length > 0 && !isScanning ? "flex" : "none";
  btnDownload.disabled = isDownloading;
}

function setStatus(type: string, text: string): void {
  statusDot.className = `status-dot ${type}`;
  statusText.textContent = text;
}

function updateStats(
  total: number,
  photos: number,
  videos: number,
  downloaded: number,
  remaining: number,
  failed: number
): void {
  statTotal.textContent = String(total);
  statPhotos.textContent = String(photos);
  statVideos.textContent = String(videos);
  statDownloaded.textContent = String(downloaded);
  statRemaining.textContent = String(remaining);
  statFailed.textContent = String(failed);
}

function updateProgress(data: ProgressInfo & { queue?: { queued: number; downloading: number; completed: number } }): void {
  progress = data;

  updateStats(
    data.totalFound,
    data.photosFound,
    data.videosFound,
    data.totalDownloaded,
    data.totalRemaining,
    data.totalFailed
  );

  // Progress bar
  if (data.totalFound > 0) {
    progressSection.style.display = "block";
    progressBar.style.width = `${data.percentComplete}%`;
    progressPercent.textContent = `${Math.round(data.percentComplete)}%`;

    if (data.estimatedTimeRemaining > 0) {
      const mins = Math.ceil(data.estimatedTimeRemaining / 60);
      progressEta.textContent = `~${mins}m remaining`;
    } else {
      progressEta.textContent = "";
    }
  } else {
    progressSection.style.display = "none";
  }

  // Queue info
  if (data.queue) {
    queueInfo.style.display = "block";
    queueQueued.textContent = String(data.queue.queued);
    queueActive.textContent = String(data.queue.downloading);
    queueDone.textContent = String(data.queue.completed);
  }

  // Update scanning state
  if (!data.isRunning && isScanning) {
    isScanning = false;
    setStatus("idle", "Scan complete");
  }

  // Update downloading state
  if (data.totalRemaining === 0 && isDownloading) {
    isDownloading = false;
    setStatus("idle", "All downloads complete");
  }

  updateUI();
}

/* ── State Persistence ─────────────────────────────────────────────────────── */

async function restoreState(): Promise<void> {
  try {
    // Restore media count from DB
    const counts = await db.getMediaCount();
    if (counts.total > 0) {
      updateStats(
        counts.total,
        counts.photos,
        counts.videos,
        counts.downloaded,
        counts.total - counts.downloaded,
        0
      );

      // Show download controls if we have media
      mediaItems = await db.getAllMedia();
      updateUI();
    }

    // Request current progress from background
    const response = await chrome.runtime.sendMessage({ action: "GET_PROGRESS" });
    if (response?.success && response.data) {
      updateProgress(response.data);
    }
  } catch {
    // Background may not be ready yet
  }
}

function handleScanComplete(payload: {
  total: number;
  photos: number;
  videos: number;
  media: MediaItem[];
}): void {
  isScanning = false;
  mediaItems = payload.media || [];

  updateStats(
    payload.total,
    payload.photos,
    payload.videos,
    0,
    payload.total,
    0
  );

  setStatus("idle", `Found ${payload.total} items`);
  updateUI();
}

/* ── Initialize ────────────────────────────────────────────────────────────── */

init().catch(console.error);
