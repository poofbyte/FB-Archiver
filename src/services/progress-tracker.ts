import type { ProgressInfo } from "../types";
import { db } from "../storage/indexeddb";
import { logger } from "../utils/logger";

type ProgressCallback = (info: ProgressInfo) => void;

/**
 * Tracks overall progress of scanning and downloading operations.
 */
export class ProgressTracker {
  private totalFound = 0;
  private totalDownloaded = 0;
  private totalFailed = 0;
  private photosFound = 0;
  private videosFound = 0;
  private isRunning = false;
  private isPaused = false;
  private isDownloading = false;
  private startTime = 0;
  private listeners: ProgressCallback[] = [];

  /**
   * Register a progress callback.
   */
  onUpdate(callback: ProgressCallback): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }

  /**
   * Update total media found during scanning.
   */
  setFound(total: number, photos: number, videos: number): void {
    this.totalFound = total;
    this.photosFound = photos;
    this.videosFound = videos;
    this.notify();
  }

  /**
   * Increment found count.
   */
  addFound(type: "photo" | "video", count: number): void {
    this.totalFound += count;
    if (type === "photo") this.photosFound += count;
    else this.videosFound += count;
    this.notify();
  }

  /**
   * Update download progress.
   */
  setDownloadProgress(downloaded: number, failed: number): void {
    this.totalDownloaded = downloaded;
    this.totalFailed = failed;
    this.notify();
  }

  /**
   * Increment downloaded count.
   */
  addDownloaded(count: number): void {
    this.totalDownloaded += count;
    this.notify();
  }

  /**
   * Increment failed count.
   */
  addFailed(count: number): void {
    this.totalFailed += count;
    this.notify();
  }

  /**
   * Set operation states.
   */
  setRunning(running: boolean): void {
    this.isRunning = running;
    if (running) {
      this.startTime = Date.now();
    }
    this.notify();
  }

  setPaused(paused: boolean): void {
    this.isPaused = paused;
    this.notify();
  }

  setDownloading(downloading: boolean): void {
    this.isDownloading = downloading;
    this.notify();
  }

  /**
   * Get current progress info.
   */
  getProgress(): ProgressInfo {
    const remaining = this.totalFound - this.totalDownloaded - this.totalFailed;
    const completed = this.totalDownloaded + this.totalFailed;
    const percentComplete = this.totalFound > 0 ? (completed / this.totalFound) * 100 : 0;

    // Estimate time remaining based on average download time
    let estimatedTimeRemaining = 0;
    if (this.totalDownloaded > 0 && this.startTime > 0) {
      const elapsed = (Date.now() - this.startTime) / 1000;
      const avgTimePerDownload = elapsed / this.totalDownloaded;
      estimatedTimeRemaining = remaining * avgTimePerDownload;
    }

    return {
      totalFound: this.totalFound,
      totalDownloaded: this.totalDownloaded,
      totalRemaining: remaining,
      totalFailed: this.totalFailed,
      photosFound: this.photosFound,
      videosFound: this.videosFound,
      percentComplete,
      estimatedTimeRemaining,
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      isDownloading: this.isDownloading,
    };
  }

  /**
   * Reset all progress.
   */
  reset(): void {
    this.totalFound = 0;
    this.totalDownloaded = 0;
    this.totalFailed = 0;
    this.photosFound = 0;
    this.videosFound = 0;
    this.isRunning = false;
    this.isPaused = false;
    this.isDownloading = false;
    this.startTime = 0;
    this.notify();
  }

  /**
   * Restore state from IndexedDB.
   */
  async restore(): Promise<void> {
    try {
      const counts = await db.getMediaCount();
      this.totalFound = counts.total;
      this.photosFound = counts.photos;
      this.videosFound = counts.videos;
      this.totalDownloaded = counts.downloaded;

      const failedItems = await db.getDownloadsByStatus("failed");
      this.totalFailed = failedItems.length;

      this.notify();
    } catch (err) {
      logger.error("Failed to restore progress", err);
    }
  }

  private notify(): void {
    const info = this.getProgress();
    for (const listener of this.listeners) {
      try {
        listener(info);
      } catch (err) {
        logger.error("Progress listener error", err);
      }
    }
  }
}

export const progressTracker = new ProgressTracker();
