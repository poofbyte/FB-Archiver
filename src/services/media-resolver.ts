import type { MediaItem, MediaVariant } from "../types";
import {
  selectBestVariant,
  isHighQualityUrl,
  getFacebookQualityUrls,
} from "../utils/url-parser";
import { logger } from "../utils/logger";

/**
 * Resolves the highest quality version of each media item.
 * For photos: upgrades CDN URLs to original quality where possible.
 * For videos: prefers HD/progressive MP4 streams.
 */
export class MediaResolver {
  async resolve(item: MediaItem): Promise<MediaItem> {
    if (item.type === "photo") {
      return this.resolvePhoto(item);
    }
    return this.resolveVideo(item);
  }

  async resolveAll(items: MediaItem[]): Promise<MediaItem[]> {
    const resolved: MediaItem[] = [];
    const BATCH = 20;

    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((item) => this.resolve(item)));
      resolved.push(...results);
      if (i + BATCH < items.length) await this.sleep(50);
    }

    logger.info(`MediaResolver: resolved ${items.length} items`);
    return resolved;
  }

  /**
   * For photos: pick the best URL from all variants, then try to upgrade
   * the CDN URL to original quality (_o suffix). The download manager
   * handles failures via retry with fallback variants.
   */
  private async resolvePhoto(item: MediaItem): Promise<MediaItem> {
    const allVariants = [...(item.allVariants ?? [])];

    // Add primary URL as variant
    allVariants.push({
      url: item.url,
      width: item.width,
      height: item.height,
      type: "photo",
    });

    // Pick best from DOM variants
    const highQuality = allVariants.filter((v) => isHighQualityUrl(v.url));
    const baseVariant = selectBestVariant(highQuality.length > 0 ? highQuality : allVariants);
    const baseUrl = baseVariant?.url ?? item.url;

    // Generate quality upgrade candidates (_o = original)
    const qualityCandidates = getFacebookQualityUrls(baseUrl);

    // Pick the first (highest quality) candidate as primary URL
    // Download manager retries with fallback variants if this fails
    const bestUrl = qualityCandidates[0] ?? baseUrl;

    // Collect all unique URLs as fallback variants
    const finalVariants: MediaVariant[] = [];
    const seenUrls = new Set<string>();

    // Add quality candidates first (highest priority)
    for (const url of qualityCandidates) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        finalVariants.push({ url, width: 0, height: 0, type: "photo" });
      }
    }

    // Then DOM variants
    for (const v of allVariants) {
      if (!seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        finalVariants.push(v);
      }
    }

    return {
      ...item,
      url: bestUrl,
      allVariants: finalVariants,
    };
  }

  private async resolveVideo(item: MediaItem): Promise<MediaItem> {
    const candidates = [...(item.allVariants ?? [])];

    candidates.push({
      url: item.url,
      width: item.width,
      height: item.height,
      type: "video",
    });

    const sorted = candidates.sort((a, b) => {
      return this.videoQualityScore(b) - this.videoQualityScore(a);
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

  private videoQualityScore(variant: MediaVariant): number {
    let score = 0;

    const pixels = (variant.width || 0) * (variant.height || 0);
    if (pixels >= 1920 * 1080) score += 1000;
    else if (pixels >= 1280 * 720) score += 500;
    else if (pixels >= 854 * 480) score += 200;
    else if (pixels >= 640 * 360) score += 100;

    if (variant.bitrate) {
      score += Math.min(variant.bitrate / 1000, 500);
    }

    const url = variant.url.toLowerCase();
    if (url.includes("1080") || url.includes("fhd")) score += 300;
    else if (url.includes("720") || url.includes("hd")) score += 200;
    else if (url.includes("480") || url.includes("sd")) score += 50;

    if (url.includes(".mp4") || url.includes("progressive")) score += 100;

    return score;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
