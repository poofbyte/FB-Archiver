import type { DownloadItem, MediaItem, DownloadStatus } from "../types";
import { DownloadManager, DownloadProgress } from "./download-manager";
import { db } from "../storage/indexeddb";
import { logger } from "../utils/logger";

type QueueUpdateCallback = () => void;

/**
 * Download queue that manages the ordered processing of media items.
 * Handles queuing, concurrency, retry, and progress tracking.
 */
export class DownloadQueue {
  private queue: DownloadItem[] = [];
  private manager: DownloadManager;
  private isProcessing = false;
  private shouldPause = false;
  private onUpdate?: QueueUpdateCallback;
  private totalQueued = 0;
  private totalCompleted = 0;
  private totalFailed = 0;

  constructor(options?: {
    maxConcurrent?: number;
    maxRetries?: number;
    onUpdate?: QueueUpdateCallback;
  }) {
    this.onUpdate = options?.onUpdate;
    this.manager = new DownloadManager({
      maxConcurrent: options?.maxConcurrent ?? 3,
      maxRetries: options?.maxRetries ?? 5,
      onProgress: (p) => this.handleProgress(p),
      onComplete: (item) => this.handleComplete(item),
      onFailed: (item, error) => this.handleFailed(item, error),
    });
  }

  /**
   * Initialize the queue manager.
   */
  init(): void {
    this.manager.init();
    logger.info("DownloadQueue initialized");
  }

  /**
   * Clean up.
   */
  destroy(): void {
    this.manager.destroy();
    this.queue = [];
  }

  /**
   * Add media items to the download queue, skipping duplicates.
   */
  async enqueue(items: MediaItem[]): Promise<void> {
    // Build a set of already-queued media IDs for dedup
    const existingMediaIds = new Set(this.queue.map((q) => q.mediaId));
    // Also check DB for completed/active downloads
    const existingDownloads = await db.getAllDownloads();
    for (const d of existingDownloads) {
      if (d.status === "completed" || d.status === "downloading") {
        existingMediaIds.add(d.mediaId);
      }
    }

    const downloadItems: DownloadItem[] = items
      .filter((item) => !item.downloaded && !existingMediaIds.has(item.id))
      .map((item) => ({
        id: `dl_${item.id}`,
        mediaId: item.id,
        url: item.url,
        filename: item.filename,
        status: "queued" as DownloadStatus,
        progress: 0,
        retryCount: 0,
      }));

    if (downloadItems.length === 0) {
      logger.info("DownloadQueue: all items already queued or downloaded, skipping");
      return;
    }

    // Save to IndexedDB
    for (const dl of downloadItems) {
      await db.addDownload(dl);
    }

    this.queue.push(...downloadItems);
    this.totalQueued += downloadItems.length;
    logger.info(`DownloadQueue: ${downloadItems.length} items enqueued (total: ${this.totalQueued})`);
    this.onUpdate?.();
  }

  /**
   * Start processing the queue.
   */
  async start(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;
    this.shouldPause = false;

    // Load any pending downloads from DB that aren't already in the queue
    const existingIds = new Set(this.queue.map((q) => q.id));
    const pending = await db.getDownloadsByStatus("queued");
    for (const p of pending) {
      if (!existingIds.has(p.id)) {
        this.queue.push(p);
      }
    }

    logger.info(`DownloadQueue: starting processing (${this.queue.length} items)`);
    await this.processQueue();
  }

  /**
   * Pause the queue.
   */
  async pause(): Promise<void> {
    this.shouldPause = true;
    await this.manager.pauseAll();
    logger.info("DownloadQueue: paused");
    this.onUpdate?.();
  }

  /**
   * Resume the queue.
   */
  async resume(): Promise<void> {
    this.shouldPause = false;
    await this.manager.resumeAll();
    this.isProcessing = true;
    logger.info("DownloadQueue: resumed");
    await this.processQueue();
    this.onUpdate?.();
  }

  /**
   * Cancel the entire queue.
   */
  async cancel(): Promise<void> {
    this.shouldPause = true;
    this.isProcessing = false;
    await this.manager.cancelAll();
    logger.info("DownloadQueue: cancelled");
    this.onUpdate?.();
  }

  /**
   * Get queue statistics.
   */
  getStats(): {
    queued: number;
    downloading: number;
    completed: number;
    failed: number;
    total: number;
    percentComplete: number;
  } {
    const downloading = this.queue.filter((q) => q.status === "downloading").length;
    const total = this.totalQueued;

    return {
      queued: this.queue.filter((q) => q.status === "queued").length,
      downloading,
      completed: this.totalCompleted,
      failed: this.totalFailed,
      total,
      percentComplete: total > 0 ? ((this.totalCompleted / total) * 100) : 0,
    };
  }

  /**
   * Get all queued items.
   */
  getItems(): DownloadItem[] {
    return [...this.queue];
  }

  /**
   * Get items by status.
   */
  getItemsByStatus(status: DownloadStatus): DownloadItem[] {
    return this.queue.filter((q) => q.status === status);
  }

  /**
   * Retry all failed downloads.
   */
  async retryFailed(): Promise<void> {
    const failed = this.queue.filter((q) => q.status === "failed");
    for (const item of failed) {
      item.status = "queued";
      item.retryCount = 0;
      item.error = undefined;
      await db.updateDownload(item);
    }
    logger.info(`DownloadQueue: retrying ${failed.length} failed downloads`);
    this.onUpdate?.();

    if (this.isProcessing) {
      await this.processQueue();
    }
  }

  /* ── Private ─────────────────────────────────────────────────────────── */

  private async processQueue(): Promise<void> {
    while (this.isProcessing && !this.shouldPause) {
      if (!this.manager.canStartMore()) {
        await this.sleep(500);
        continue;
      }

      const nextItem = this.queue.find((q) => q.status === "queued");
      if (!nextItem) {
        // No more items to process
        if (this.manager.getActiveCount() === 0) {
          logger.info("DownloadQueue: all downloads finished");
          this.isProcessing = false;
          break;
        }
        await this.sleep(500);
        continue;
      }

      await this.manager.startDownload(nextItem);
      this.onUpdate?.();
      await this.sleep(100);
    }
  }

  private handleProgress(progress: DownloadProgress): void {
    const item = this.queue.find((q) => q.id === progress.downloadId);
    if (item) {
      item.progress = progress.progress;
      item.byteReceived = progress.bytesReceived;
      item.totalBytes = progress.totalBytes;
    }
    this.onUpdate?.();
  }

  private handleComplete(_item: DownloadItem): void {
    this.totalCompleted++;
    this.onUpdate?.();
  }

  private handleFailed(_item: DownloadItem, _error: string): void {
    this.totalFailed++;
    this.onUpdate?.();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
