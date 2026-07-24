import type {
  ExtensionMessage,
  MessageResponse,
  MediaItem,
  ProgressInfo,
  Settings,
} from "../types";
import { MediaExtractor } from "../services/media-extractor";
import { MediaResolver } from "../services/media-resolver";
import { AutoScroller } from "../services/auto-scroller";
import { DuplicateDetector } from "../utils/dedup";
import { logger } from "../utils/logger";

/**
 * Content script entry point.
 * Runs on Facebook pages, orchestrates scanning, extraction, and communicates
 * with the background service worker for downloads.
 */

let scroller: AutoScroller | null = null;
let extractor: MediaExtractor;
let resolver: MediaResolver;
let dedup: DuplicateDetector;
let allMedia: MediaItem[] = [];
let isScanning = false;
let settings: Settings = {
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

function init(): void {
  extractor = new MediaExtractor();
  resolver = new MediaResolver();
  dedup = new DuplicateDetector();

  // Listen for messages from background/popup
  chrome.runtime.onMessage.addListener(
    (message: ExtensionMessage, _sender, sendResponse) => {
      handleMessage(message).then(sendResponse).catch((err) => {
        sendResponse({ success: false, error: String(err) });
      });
      return true; // async response
    }
  );

  // Notify background that content script is ready
  chrome.runtime.sendMessage({
    action: "CONTENT_SCRIPT_READY",
    payload: { url: window.location.href },
  });

  logger.info("Content script initialized", { url: window.location.href });
}

async function handleMessage(message: ExtensionMessage): Promise<MessageResponse> {
  switch (message.action) {
    case "START_SCAN":
      return handleStartScan(message.payload as Settings);

    case "STOP_SCAN":
      return handleStopScan();

    case "PAUSE_SCAN":
      return handlePauseScan();

    case "RESUME_SCAN":
      return handleResumeScan();

    case "GET_PROGRESS":
      return { success: true, data: getProgress() };

    case "GET_MEDIA":
      return { success: true, data: allMedia };

    default:
      return { success: false, error: `Unknown action: ${message.action}` };
  }
}

async function handleStartScan(newSettings?: Settings): Promise<MessageResponse> {
  if (isScanning) {
    return { success: false, error: "Scan already in progress" };
  }

  if (newSettings) {
    settings = newSettings;
  }

  isScanning = true;
  extractor.reset();
  dedup.reset();
  allMedia = [];

  logger.info("Starting scan", { url: window.location.href });

  // Initial extraction before scrolling
  const initialItems = extractor.extractAll();
  allMedia = dedup.filterUnique(initialItems);

  notifyProgress();

  // Set up auto-scroller
  scroller = new AutoScroller({ speed: settings.scrollSpeed });
  scroller.onProgressCallback((scrollInfo) => {
    // Extract new media as we scroll
    const newItems = extractor.extractAll();
    const unique = dedup.filterUnique(newItems);
    if (unique.length > 0) {
      allMedia.push(...unique);
      notifyProgress();
    }

    // Report scroll progress to background
    chrome.runtime.sendMessage({
      action: "SCROLL_PROGRESS",
      payload: {
        scrollHeight: scrollInfo.scrollHeight,
        scrollPosition: scrollInfo.scrollPosition,
        idleCount: scrollInfo.idleCount,
        mediaCount: allMedia.length,
      },
    });

    // Check max media count
    if (settings.maxMediaCount > 0 && allMedia.length >= settings.maxMediaCount) {
      logger.info(`Max media count reached: ${settings.maxMediaCount}`);
      scroller?.stop();
    }
  });

  try {
    await scroller.start(allMedia.length);
  } catch (err) {
    logger.error("Scroller error", err);
  }

  // Final extraction after scrolling completes
  const finalItems = extractor.extractAll();
  const finalUnique = dedup.filterUnique(finalItems);
  if (finalUnique.length > 0) {
    allMedia.push(...finalUnique);
  }

  // Resolve best quality for all items
  logger.info(`Resolving quality for ${allMedia.length} items...`);
  allMedia = await resolver.resolveAll(allMedia);

  isScanning = false;

  // Notify background scan is complete
  chrome.runtime.sendMessage({
    action: "SCAN_COMPLETE",
    payload: {
      total: allMedia.length,
      photos: allMedia.filter((m) => m.type === "photo").length,
      videos: allMedia.filter((m) => m.type === "video").length,
      media: allMedia,
    },
  });

  notifyProgress();

  return {
    success: true,
    data: {
      total: allMedia.length,
      photos: allMedia.filter((m) => m.type === "photo").length,
      videos: allMedia.filter((m) => m.type === "video").length,
    },
  };
}

function handleStopScan(): MessageResponse {
  scroller?.stop();
  isScanning = false;

  chrome.runtime.sendMessage({
    action: "SCAN_COMPLETE",
    payload: {
      total: allMedia.length,
      photos: allMedia.filter((m) => m.type === "photo").length,
      videos: allMedia.filter((m) => m.type === "video").length,
      media: allMedia,
    },
  });

  return { success: true };
}

function handlePauseScan(): MessageResponse {
  scroller?.pause();
  return { success: true };
}

function handleResumeScan(): MessageResponse {
  scroller?.resume();
  return { success: true };
}

function getProgress(): ProgressInfo {
  const photos = allMedia.filter((m) => m.type === "photo").length;
  const videos = allMedia.filter((m) => m.type === "video").length;
  const total = allMedia.length;

  return {
    totalFound: total,
    totalDownloaded: 0,
    totalRemaining: total,
    totalFailed: 0,
    photosFound: photos,
    videosFound: videos,
    percentComplete: isScanning ? 0 : 100,
    estimatedTimeRemaining: 0,
    isRunning: isScanning,
    isPaused: false,
    isDownloading: false,
  };
}

function notifyProgress(): void {
  chrome.runtime.sendMessage({
    action: "MEDIA_FOUND",
    payload: getProgress(),
  });
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
