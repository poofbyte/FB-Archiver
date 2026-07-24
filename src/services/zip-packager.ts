import type { MediaItem, Settings } from "../types";
import { logger } from "../utils/logger";
import { sanitizeFilename } from "../utils/url-parser";

/**
 * Packages downloaded media files into ZIP archives.
 * Uses offscreen document for Blob/URL APIs unavailable in MV3 service workers.
 */
export class ZipPackager {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /**
   * Ensure the offscreen document exists for ZIP creation.
   */
  private async ensureOffscreen(): Promise<void> {
    try {
      await chrome.offscreen.createDocument({
        url: "src/background/offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "ZIP file creation requires Blob/URL APIs unavailable in service workers",
      });
    } catch {
      // Already exists — that's fine
    }
  }

  /**
   * Fetch a single file with timeout and retry.
   */
  private async fetchWithRetry(url: string, retries = 2): Promise<ArrayBuffer | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
          credentials: "include",
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
          logger.warn(`ZipPackager: HTTP ${response.status} for ${url.slice(0, 80)}...`);
          if (attempt < retries) continue;
          return null;
        }

        return await response.arrayBuffer();
      } catch (err) {
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        logger.error(`ZipPackager: fetch failed after ${retries + 1} attempts`, String(err));
        return null;
      }
    }
    return null;
  }

  /**
   * Create a ZIP archive for given media items and trigger download.
   * Fetches files in batches, then hands them to the offscreen document.
   */
  async createZip(items: MediaItem[], type: "photos" | "videos"): Promise<string> {
    const suffix = type === "photos" ? this.settings.zipSuffixPhotos : this.settings.zipSuffixVideos;

    const entries: { path: string; data: number[] }[] = [];
    const BATCH_SIZE = 5;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (item, batchIdx) => {
          const data = await this.fetchWithRetry(item.url);
          if (!data) return null;
          const albumSlug = sanitizeFilename(item.album || "General");
          const filename = item.filename || `file_${i + batchIdx}`;
          return { path: `${albumSlug}/${filename}`, data: Array.from(new Uint8Array(data)) };
        })
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          entries.push(result.value);
        }
      }

      logger.info(`ZipPackager: fetched ${Math.min(i + BATCH_SIZE, items.length)}/${items.length} for ${type}`);
      await new Promise((r) => setTimeout(r, 10));
    }

    if (entries.length === 0) {
      logger.warn(`ZipPackager: no files fetched for ${type} zip`);
      return "";
    }

    try {
      await this.ensureOffscreen();

      await chrome.runtime.sendMessage({
        action: "CREATE_ZIP_AND_DOWNLOAD",
        payload: {
          entries,
          zipName: `facebook_${type}${suffix}.zip`,
        },
      });

      logger.info(`ZipPackager: ${type} zip (${entries.length} files) sent to offscreen`);
      return `facebook_${type}${suffix}.zip`;
    } catch (err) {
      logger.error(`ZipPackager: failed to create ${type} zip`, err);
      return "";
    }
  }
}
