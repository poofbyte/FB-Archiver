import type { Settings } from "../types";
import { logger } from "../utils/logger";

/**
 * Packages downloaded media files into ZIP archives.
 * Sends metadata (URLs + filenames) to the offscreen document which handles
 * fetching, ZIP creation, and download — all in one place with DOM access.
 */
export class ZipPackager {
  private settings: Settings;
  private isCreating = false;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /**
   * Ensure the offscreen document exists.
   */
  private async ensureOffscreen(): Promise<void> {
    try {
      await chrome.offscreen.createDocument({
        url: "src/background/offscreen.html",
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: "ZIP creation needs Blob/URL APIs not available in service workers",
      });
      // Wait a tick for the offscreen page to load and register its listener
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      // Already exists — good
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Create ZIPs for photos and videos. Sends only metadata to offscreen.
   */
  async packageAll(): Promise<void> {
    if (this.isCreating) {
      logger.info("ZipPackager: already creating, skipping");
      return;
    }

    this.isCreating = true;
    try {
      await this.ensureOffscreen();

      // Import db here to avoid circular deps at module load time
      const { db } = await import("../storage/indexeddb");
      const allMedia = await db.getAllMedia();
      const downloaded = allMedia.filter((m) => m.downloaded);

      if (downloaded.length === 0) {
        logger.info("ZipPackager: no downloaded media to package");
        return;
      }

      const photos = downloaded.filter((m) => m.type === "photo");
      const videos = downloaded.filter((m) => m.type === "video");

      const suffix = this.settings.autoZip
        ? { photos: this.settings.zipSuffixPhotos, videos: this.settings.zipSuffixVideos }
        : { photos: "_photos", videos: "_videos" };

      // Send metadata to offscreen — it will fetch and create the ZIP
      if (photos.length > 0) {
        logger.info(`ZipPackager: sending ${photos.length} photos to offscreen`);
        chrome.runtime.sendMessage({
          action: "OFFSCREEN_CREATE_ZIP",
          payload: {
            files: photos.map((m) => ({ url: m.url, filename: m.filename, album: m.album })),
            zipName: `facebook_photos${suffix.photos}.zip`,
          },
        });
      }

      if (videos.length > 0) {
        logger.info(`ZipPackager: sending ${videos.length} videos to offscreen`);
        chrome.runtime.sendMessage({
          action: "OFFSCREEN_CREATE_ZIP",
          payload: {
            files: videos.map((m) => ({ url: m.url, filename: m.filename, album: m.album })),
            zipName: `facebook_videos${suffix.videos}.zip`,
          },
        });
      }

      // Auto-export metadata
      if (this.settings.autoExport) {
        const { exportMetadata, downloadExport } = await import("../utils/export");
        const json = exportMetadata(downloaded, "json");
        await downloadExport(json, "json");
      }
    } catch (err) {
      logger.error("ZipPackager: failed", err);
    } finally {
      this.isCreating = false;
    }
  }
}
