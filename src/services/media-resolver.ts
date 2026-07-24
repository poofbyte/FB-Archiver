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
   * Resolve a batch of media items in parallel batches.
   */
  async resolveAll(items: MediaItem[]): Promise<MediaItem[]> {
    const resolved: MediaItem[] = [];
    const BATCH = 20;

    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((item) => this.resolve(item)));
      resolved.push(...results);

      if (i + BATCH < items.length) {
        await this.sleep(50);
      }
    }

    logger.info(`MediaResolver: resolved ${items.length} items`);
    return resolved;
  }

  /**
   * For photos: try upgrading the CDN URL to original quality.
   * Strategy:
   * 1. Collect all variants from the DOM (src, srcset, data attrs)
   * 2. For the best URL found, generate quality upgrade candidates (_o, _n, etc.)
   * 3. Pick the highest-quality candidate (we verify during download via HEAD)
   * 4. Return the upgraded URL as primary, original as fallback
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

    // Pick the best variant we already have
    const highQuality = allVariants.filter((v) => isHighQualityUrl(v.url));
    const baseVariant = selectBestVariant(highQuality.length > 0 ? highQuality : allVariants);
    const baseUrl = baseVariant?.url ?? item.url;

    // Generate quality upgrade candidates for the best URL
    const qualityCandidates = getFacebookQualityUrls(baseUrl);

    // Try to find the best working URL via HEAD requests (in parallel, with timeout)
    const bestUrl = await this.findBestUrl(qualityCandidates, baseUrl);

    // Also collect all unique URLs as variants for fallback
    const finalVariants: MediaVariant[] = [];
    const seenUrls = new Set<string>();
    for (const v of allVariants) {
      if (!seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        finalVariants.push(v);
      }
    }
    // Add quality candidates as variants too
    for (const url of qualityCandidates) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        finalVariants.push({ url, width: 0, height: 0, type: "photo" });
      }
    }

    return {
      ...item,
      url: bestUrl,
      allVariants: finalVariants,
    };
  }

  /**
   * Try HEAD requests on candidate URLs and return the one with the largest content.
   * Falls back to the original URL if all fail.
   */
  private async findBestUrl(candidates: string[], fallback: string): Promise<string> {
    if (candidates.length <= 1) return candidates[0] ?? fallback;

    // Try candidates in parallel with a short timeout
    // First one that returns a large Content-Length wins
    const results = await Promise.allSettled(
      candidates.map(async (url) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);

          const response = await fetch(url, {
            method: "HEAD",
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.ok) {
            const contentLength = parseInt(response.headers.get("content-length") ?? "0", 10);
            const contentType = response.headers.get("content-type") ?? "";
            // Must be an image
            if (contentType.startsWith("image/")) {
              return { url, contentLength };
            }
          }
          return null;
        } catch {
          return null;
        }
      })
    );

    // Pick the candidate with the largest content-length
    let bestUrl = fallback;
    let bestSize = 0;

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        if (result.value.contentLength > bestSize) {
          bestSize = result.value.contentLength;
          bestUrl = result.value.url;
        }
      }
    }

    if (bestUrl !== fallback && bestSize > 0) {
      logger.debug(`MediaResolver: upgraded URL (${bestSize} bytes)`);
    }

    return bestUrl;
  }

  /**
   * For videos: try to find HD or original quality stream.
   */
  private async resolveVideo(item: MediaItem): Promise<MediaItem> {
    const candidates = [...(item.allVariants ?? [])];

    // Add the primary URL
    candidates.push({
      url: item.url,
      width: item.width,
      height: item.height,
      type: "video",
    });

    // Sort by quality preference
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
