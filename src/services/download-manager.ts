import type { DownloadItem, DownloadStatus } from "../types";
import { db } from "../storage/indexeddb";
import { logger } from "../utils/logger";

export interface DownloadProgress {
  downloadId: string;
  mediaId: string;
  progress: number;
  status: DownloadStatus;
  bytesReceived?: number;
  totalBytes?: number;
}

type ProgressCallback = (progress: DownloadProgress) => void;
type CompleteCallback = (item: DownloadItem) => void;
type FailedCallback = (item: DownloadItem, error: string) => void;

/**
 * Manages the Chrome downloads API, tracking individual downloads
 * with retry, pause/resume, and progress reporting.
 */
export class DownloadManager {
  private activeDownloads = new Map<number, DownloadItem>();
  private maxConcurrent = 3;
  private maxRetries = 5;
  private onProgress?: ProgressCallback;
  private onComplete?: CompleteCallback;
  private onFailed?: FailedCallback;
  private downloadListener: ((delta: chrome.downloads.DownloadDelta) => void) | null = null;

  constructor(options?: {
    maxConcurrent?: number;
    maxRetries?: number;
    onProgress?: ProgressCallback;
    onComplete?: CompleteCallback;
    onFailed?: FailedCallback;
  }) {
    if (options?.maxConcurrent) this.maxConcurrent = options.maxConcurrent;
    if (options?.maxRetries) this.maxRetries = options.maxRetries;
    this.onProgress = options?.onProgress;
    this.onComplete = options?.onComplete;
    this.onFailed = options?.onFailed;
  }

  /**
   * Set up Chrome downloads event listener.
   */
  init(): void {
    if (this.downloadListener) return;

    this.downloadListener = (delta: chrome.downloads.DownloadDelta) => {
      this.handleDownloadDelta(delta);
    };

    chrome.downloads.onChanged.addListener(this.downloadListener);
    logger.info("DownloadManager initialized");
  }

  /**
   * Clean up listeners.
   */
  destroy(): void {
    if (this.downloadListener) {
      chrome.downloads.onChanged.removeListener(this.downloadListener);
      this.downloadListener = null;
    }
    this.activeDownloads.clear();
  }

  /**
   * Start downloading an item.
   */
  async startDownload(item: DownloadItem): Promise<boolean> {
    if (this.activeDownloads.size >= this.maxConcurrent) {
      logger.debug("Max concurrent downloads reached, queuing");
      return false;
    }

    try {
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename: item.filename,
        saveAs: false,
        conflictAction: "uniquify",
      });

      item.downloadId = downloadId;
      item.status = "downloading";
      item.startedAt = Date.now();
      this.activeDownloads.set(downloadId, item);

      await db.updateDownload(item);
      logger.debug(`Download started: ${item.filename} (ID: ${downloadId})`);
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Download failed to start: ${item.filename}`, errorMsg);
      item.status = "failed";
      item.error = errorMsg;
      await db.updateDownload(item);
      this.onFailed?.(item, errorMsg);
      return false;
    }
  }

  /**
   * Pause a specific download.
   */
  async pauseDownload(downloadId: number): Promise<void> {
    try {
      await chrome.downloads.pause(downloadId);
      const item = this.activeDownloads.get(downloadId);
      if (item) {
        item.status = "paused";
        await db.updateDownload(item);
      }
      logger.info(`Download paused: ${downloadId}`);
    } catch (err) {
      logger.error(`Failed to pause download: ${downloadId}`, err);
    }
  }

  /**
   * Resume a paused download.
   */
  async resumeDownload(downloadId: number): Promise<void> {
    try {
      await chrome.downloads.resume(downloadId);
      const item = this.activeDownloads.get(downloadId);
      if (item) {
        item.status = "downloading";
        await db.updateDownload(item);
      }
      logger.info(`Download resumed: ${downloadId}`);
    } catch (err) {
      logger.error(`Failed to resume download: ${downloadId}`, err);
    }
  }

  /**
   * Cancel a download.
   */
  async cancelDownload(downloadId: number): Promise<void> {
    try {
      await chrome.downloads.cancel(downloadId);
      const item = this.activeDownloads.get(downloadId);
      if (item) {
        item.status = "cancelled";
        await db.updateDownload(item);
        this.activeDownloads.delete(downloadId);
      }
      logger.info(`Download cancelled: ${downloadId}`);
    } catch (err) {
      logger.error(`Failed to cancel download: ${downloadId}`, err);
    }
  }

  /**
   * Cancel all active downloads.
   */
  async cancelAll(): Promise<void> {
    const ids = Array.from(this.activeDownloads.keys());
    await Promise.all(ids.map((id) => this.cancelDownload(id)));
  }

  /**
   * Pause all active downloads.
   */
  async pauseAll(): Promise<void> {
    const ids = Array.from(this.activeDownloads.keys());
    await Promise.all(ids.map((id) => this.pauseDownload(id)));
  }

  /**
   * Resume all paused downloads.
   */
  async resumeAll(): Promise<void> {
    const items = await db.getDownloadsByStatus("paused");
    for (const item of items) {
      if (item.downloadId) {
        await this.resumeDownload(item.downloadId);
      }
    }
  }

  /**
   * Retry a failed download, cycling through fallback URLs from allVariants.
   */
  async retryDownload(item: DownloadItem): Promise<boolean> {
    if (item.retryCount >= this.maxRetries) {
      logger.warn(`Max retries reached for: ${item.filename}`);
      return false;
    }

    item.retryCount++;
    item.status = "queued";
    item.error = undefined;
    item.downloadId = undefined;

    // Try next fallback URL from the media item's allVariants
    try {
      const mediaItem = await db.getMedia(item.mediaId);
      if (mediaItem?.allVariants && mediaItem.allVariants.length > 1) {
        const currentIdx = mediaItem.allVariants.findIndex((v) => v.url === item.url);
        const nextIdx = currentIdx + 1;
        if (nextIdx < mediaItem.allVariants.length) {
          item.url = mediaItem.allVariants[nextIdx].url;
          logger.info(`Trying fallback URL for ${item.filename}: variant ${nextIdx + 1}/${mediaItem.allVariants.length}`);
        }
      }
    } catch {
      // Ignore DB errors, retry with same URL
    }

    // Exponential backoff delay
    const delay = Math.min(1000 * Math.pow(2, item.retryCount - 1), 30000);
    await this.sleep(delay);

    await db.updateDownload(item);
    logger.info(`Retrying download: ${item.filename} (attempt ${item.retryCount})`);
    return this.startDownload(item);
  }

  /**
   * Handle Chrome download state changes.
   */
  private async handleDownloadDelta(delta: chrome.downloads.DownloadDelta): Promise<void> {
    const item = this.activeDownloads.get(delta.id);
    if (!item) return;

    if (delta.state) {
      switch (delta.state.current) {
        case "complete": {
          item.status = "completed";
          item.completedAt = Date.now();
          this.activeDownloads.delete(delta.id);

          // Get final file path
          try {
            const [download] = await chrome.downloads.search({ id: delta.id });
            if (download?.filename) {
              item.downloadPath = download.filename;
            }
          } catch {
            // Ignore search errors
          }

          await db.updateDownload(item);
          logger.info(`Download complete: ${item.filename}`);
          this.onComplete?.(item);
          break;
        }

        case "interrupted": {
          const error = delta.error?.current ?? "Unknown error";
          logger.warn(`Download interrupted: ${item.filename} - ${error}`);
          this.activeDownloads.delete(delta.id);

          // Rate limiting detection
          if (error.includes("SERVER_ERROR") || error.includes("TOO_MANY_REQUESTS")) {
            const retryDelay = Math.min(30000, 5000 * (item.retryCount + 1));
            await this.sleep(retryDelay);
          }

          if (item.retryCount < this.maxRetries) {
            await this.retryDownload(item);
          } else {
            item.status = "failed";
            item.error = error;
            await db.updateDownload(item);
            this.onFailed?.(item, error);
          }
          break;
        }
      }
    }

    // Progress updates via periodic search
    if (item.status === "downloading") {
      try {
        const [download] = await chrome.downloads.search({ id: delta.id });
        if (download) {
          item.byteReceived = download.bytesReceived ?? 0;
          item.totalBytes = download.totalBytes ?? 0;

          const totalBytes = item.totalBytes ?? 0;
          const bytesReceived = item.byteReceived ?? 0;
          item.progress = totalBytes > 0 ? (bytesReceived / totalBytes) * 100 : 0;

          this.onProgress?.({
            downloadId: String(delta.id),
            mediaId: item.mediaId,
            progress: item.progress,
            status: item.status,
            bytesReceived,
            totalBytes,
          });
        }
      } catch {
        // Ignore search errors during progress updates
      }
    }
  }

  /**
   * Get the number of active (in-progress) downloads.
   */
  getActiveCount(): number {
    return this.activeDownloads.size;
  }

  /**
   * Check if we can start more downloads.
   */
  canStartMore(): boolean {
    return this.activeDownloads.size < this.maxConcurrent;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
