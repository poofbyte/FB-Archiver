import JSZip from "jszip";
import type { MediaItem, Settings } from "../types";
import { db } from "../storage/indexeddb";
import { logger } from "../utils/logger";
import { sanitizeFilename } from "../utils/url-parser";

/**
 * Packages downloaded media files into ZIP archives.
 * Creates separate ZIPs for photos and videos.
 */
export class ZipPackager {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  /**
   * Update settings.
   */
  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  /**
   * Create ZIP archives for all downloaded media.
   */
  async packageAll(): Promise<{ photosZip?: string; videosZip?: string }> {
    if (!this.settings.autoZip) {
      logger.info("ZipPackager: auto-zip disabled");
      return {};
    }

    const allMedia = await db.getAllMedia();
    const downloaded = allMedia.filter((m) => m.downloaded);

    if (downloaded.length === 0) {
      logger.info("ZipPackager: no downloaded media to package");
      return {};
    }

    const photos = downloaded.filter((m) => m.type === "photo");
    const videos = downloaded.filter((m) => m.type === "video");

    const result: { photosZip?: string; videosZip?: string } = {};

    if (photos.length > 0) {
      result.photosZip = await this.createZip(photos, "photos");
    }

    if (videos.length > 0) {
      result.videosZip = await this.createZip(videos, "videos");
    }

    return result;
  }

  /**
   * Create a ZIP from a list of media items.
   */
  async createZip(items: MediaItem[], type: "photos" | "videos"): Promise<string> {
    const zip = new JSZip();
    const suffix = type === "photos" ? this.settings.zipSuffixPhotos : this.settings.zipSuffixVideos;

    // Organize by album
    const byAlbum = new Map<string, MediaItem[]>();
    for (const item of items) {
      const album = item.album || "General";
      if (!byAlbum.has(album)) byAlbum.set(album, []);
      byAlbum.get(album)!.push(item);
    }

    // Add files to ZIP organized by album folders
    let fileCount = 0;
    for (const [album, albumItems] of byAlbum) {
      const albumSlug = sanitizeFilename(album);

      for (const item of albumItems) {
        try {
          // Fetch the file data
          const response = await fetch(item.url, { credentials: "include" });
          if (!response.ok) {
            logger.warn(`ZipPackager: failed to fetch ${item.url}: ${response.status}`);
            continue;
          }

          const blob = await response.blob();
          const data = await blob.arrayBuffer();

          const filename = item.filename || `file_${fileCount}`;
          const path = `${albumSlug}/${filename}`;
          zip.file(path, data);
          fileCount++;

          // Progress logging every 10 files
          if (fileCount % 10 === 0) {
            logger.info(`ZipPackager: added ${fileCount} files to ${type} zip`);
          }
        } catch (err) {
          logger.error(`ZipPackager: error adding ${item.filename} to zip`, err);
        }
      }
    }

    if (fileCount === 0) {
      logger.warn(`ZipPackager: no files added to ${type} zip`);
      return "";
    }

    // Generate the ZIP
    logger.info(`ZipPackager: generating ${type} zip with ${fileCount} files...`);
    const content = await zip.generateAsync(
      {
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      },
      (metadata) => {
        logger.debug(`ZipPackager: ${type} zip progress: ${metadata.percent.toFixed(1)}%`);
      }
    );

    // Trigger download
    const zipName = `facebook_${type}${suffix}.zip`;
    const url = URL.createObjectURL(content);

    try {
      await chrome.downloads.download({
        url,
        filename: zipName,
        saveAs: true,
      });
      logger.info(`ZipPackager: ${zipName} download initiated`);
      return zipName;
    } catch (err) {
      logger.error(`ZipPackager: failed to download ${zipName}`, err);
      return "";
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
