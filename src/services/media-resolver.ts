import type { MediaItem, MediaVariant } from "../types";
import { selectBestVariant, isHighQualityUrl } from "../utils/url-parser";
import { logger } from "../utils/logger";

/**
 * Resolves the highest quality version of each media item.
 * For photos: prefers original/full-resolution images.
 * For videos: prefers HD/progressive MP4 streams.
 */
export class MediaResolver {
  /**
   * Resolve a single media item to its best quality URL.
   */
  async resolve(item: MediaItem): Promise<MediaItem> {
    if (item.type === "photo") {
      return this.resolvePhoto(item);
    }
    return this.resolveVideo(item);
  }

  /**
   * Resolve a batch of media items.
   */
  async resolveAll(items: MediaItem[]): Promise<MediaItem[]> {
    const resolved: MediaItem[] = [];
    const batchSize = 20;

    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const results = await Promise.all(batch.map((item) => this.resolve(item)));
      resolved.push(...results);

      if (i + batchSize < items.length) {
        await this.sleep(100);
      }
    }

    logger.info(`MediaResolver: resolved ${items.length} items`);
    return resolved;
  }

  /**
   * For photos: try to find the original/full-size URL.
   * Facebook CDN URLs contain resolution info and can be manipulated.
   */
  private async resolvePhoto(item: MediaItem): Promise<MediaItem> {
    const candidates = item.allVariants ?? [];

    // Add the primary URL as a candidate
    candidates.push({
      url: item.url,
      width: item.width,
      height: item.height,
      type: "photo",
    });

    // Filter out known low-quality patterns
    const highQuality = candidates.filter((v) => isHighQualityUrl(v.url));

    const candidatesToUse = highQuality.length > 0 ? highQuality : candidates;
    const best = selectBestVariant(candidatesToUse);

    if (best) {
      return {
        ...item,
        url: best.url,
        width: best.width || item.width,
        height: best.height || item.height,
        allVariants: candidates,
      };
    }

    return item;
  }

  /**
   * For videos: try to find HD or original quality stream.
   * Attempts to fetch the video page and extract the best source.
   */
  private async resolveVideo(item: MediaItem): Promise<MediaItem> {
    const candidates = item.allVariants ?? [];

    // Add the primary URL
    candidates.push({
      url: item.url,
      width: item.width,
      height: item.height,
      type: "video",
    });

    // Sort by quality preference: highest quality first
    const sorted = candidates.sort((a, b) => {
      const aScore = this.videoQualityScore(a);
      const bScore = this.videoQualityScore(b);
      return bScore - aScore;
    });

    if (sorted.length > 0) {
      const best = sorted[0];
      return {
        ...item,
        url: best.url,
        width: best.width || item.width,
        height: best.height || item.height,
        bitrate: best.bitrate || item.bitrate,
        allVariants: candidates,
      };
    }

    return item;
  }

  /**
   * Score a video variant for quality ranking.
   */
  private videoQualityScore(variant: MediaVariant): number {
    let score = 0;

    // Resolution scoring
    const pixels = (variant.width || 0) * (variant.height || 0);
    if (pixels >= 1920 * 1080) score += 1000;
    else if (pixels >= 1280 * 720) score += 500;
    else if (pixels >= 854 * 480) score += 200;
    else if (pixels >= 640 * 360) score += 100;

    // Bitrate scoring
    if (variant.bitrate) {
      score += Math.min(variant.bitrate / 1000, 500);
    }

    // URL quality indicators
    const url = variant.url.toLowerCase();
    if (url.includes("1080") || url.includes("fhd")) score += 300;
    else if (url.includes("720") || url.includes("hd")) score += 200;
    else if (url.includes("480") || url.includes("sd")) score += 50;

    // Prefer progressive download URLs
    if (url.includes(".mp4") || url.includes("progressive")) score += 100;

    return score;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
