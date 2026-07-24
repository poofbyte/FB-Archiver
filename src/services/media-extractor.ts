import type { MediaItem, MediaVariant, MediaSource } from "../types";
import {
  isFacebookCdn,
  selectBestVariant,
  generateFingerprint,
  buildFilename,
  parseVideoSource,
} from "../utils/url-parser";
import { DuplicateDetector } from "../utils/dedup";
import { logger } from "../utils/logger";

let mediaIndex = 0;

/**
 * Extracts all media items from the current Facebook page DOM.
 * Uses multiple strategies: DOM parsing, srcset analysis, data attributes,
 * background images, and video source detection.
 */
export class MediaExtractor {
  private dedup = new DuplicateDetector();
  private seenIds = new Set<string>();

  reset(): void {
    this.dedup.reset();
    this.seenIds.clear();
    mediaIndex = 0;
  }

  /**
   * Extract all media from the current page.
   */
  extractAll(): MediaItem[] {
    const photos = this.extractPhotos();
    const videos = this.extractVideos();
    const all = [...photos, ...videos];
    const unique = this.dedup.filterUnique(all);

    logger.info(`MediaExtractor: found ${all.length} raw, ${unique.length} unique items`);
    return unique;
  }

  /**
   * Extract photos using multiple DOM strategies.
   */
  extractPhotos(): MediaItem[] {
    const items: MediaItem[] = [];

    // Strategy 1: Direct image elements
    items.push(...this.extractFromImageElements());

    // Strategy 2: Background images in containers
    items.push(...this.extractFromBackgroundImages());

    // Strategy 3: Lazy-loaded images (data-src, etc.)
    items.push(...this.extractFromLazyImages());

    // Strategy 4: Parse all linked full-size images
    items.push(...this.extractFromLinks());

    return items;
  }

  private extractFromImageElements(): MediaItem[] {
    const items: MediaItem[] = [];
    const images = document.querySelectorAll<HTMLImageElement>("img");

    for (const img of images) {
      const variants = this.collectImageVariants(img);
      if (variants.length === 0) continue;

      const best = selectBestVariant(variants);
      if (!best) continue;

      const source = this.detectSource(img);
      const album = this.detectAlbum(img);
      const item = this.buildPhotoItem(best.url, best.width, best.height, source, album, variants);

      if (item && !this.seenIds.has(item.id)) {
        this.seenIds.add(item.id);
        items.push(item);
      }
    }

    return items;
  }

  private extractFromBackgroundImages(): MediaItem[] {
    const items: MediaItem[] = [];
    const containers = document.querySelectorAll<HTMLElement>(
      '[style*="background-image"], [role="img"]'
    );

    for (const el of containers) {
      const bgImage = el.style.backgroundImage;
      if (!bgImage || bgImage === "none") continue;

      const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
      if (!urlMatch) continue;

      const url = urlMatch[1];
      if (!this.isFacebookMediaUrl(url)) continue;

      const source = this.detectSource(el);
      const album = this.detectAlbum(el);
      const item = this.buildPhotoItem(url, 0, 0, source, album);

      if (item && !this.seenIds.has(item.id)) {
        this.seenIds.add(item.id);
        items.push(item);
      }
    }

    return items;
  }

  private extractFromLazyImages(): MediaItem[] {
    const items: MediaItem[] = [];
    const lazyElements = document.querySelectorAll<HTMLElement>(
      "[data-src], [data-hqsrc], [data-fullsrc], [data-bigsrc]"
    );

    for (const el of lazyElements) {
      for (const attr of ["data-src", "data-hqsrc", "data-fullsrc", "data-bigsrc"]) {
        const url = el.getAttribute(attr);
        if (!url || !this.isFacebookMediaUrl(url)) continue;

        const source = this.detectSource(el);
        const album = this.detectAlbum(el);
        const item = this.buildPhotoItem(url, 0, 0, source, album);

        if (item && !this.seenIds.has(item.id)) {
          this.seenIds.add(item.id);
          items.push(item);
        }
      }
    }

    return items;
  }

  private extractFromLinks(): MediaItem[] {
    const items: MediaItem[] = [];
    const links = document.querySelectorAll<HTMLAnchorElement>("a[href]");

    for (const link of links) {
      const href = link.href;
      if (!href) continue;

      // Links to photo viewer pages
      if (/\/photo[s]\/\?fbid=/.test(href) || /\/photos\/.*\//.test(href)) {
        const img = link.querySelector("img");
        if (img) {
          const variants = this.collectImageVariants(img);
          const best = selectBestVariant(variants);
          if (best) {
            const source = this.detectSource(link);
            const album = this.detectAlbum(link);
            const item = this.buildPhotoItem(
              best.url,
              best.width,
              best.height,
              source,
              album,
              variants
            );
            if (item && !this.seenIds.has(item.id)) {
              this.seenIds.add(item.id);
              items.push(item);
            }
          }
        }
      }

      // Direct media links
      if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(href) && this.isFacebookMediaUrl(href)) {
        const source = this.detectSource(link);
        const album = this.detectAlbum(link);
        const item = this.buildPhotoItem(href, 0, 0, source, album);
        if (item && !this.seenIds.has(item.id)) {
          this.seenIds.add(item.id);
          items.push(item);
        }
      }
    }

    return items;
  }

  /**
   * Extract videos using multiple strategies.
   */
  extractVideos(): MediaItem[] {
    const items: MediaItem[] = [];

    // Strategy 1: <video> elements
    items.push(...this.extractFromVideoElements());

    // Strategy 2: Video links
    items.push(...this.extractFromVideoLinks());

    return items;
  }

  private extractFromVideoElements(): MediaItem[] {
    const items: MediaItem[] = [];
    const videos = document.querySelectorAll<HTMLVideoElement>("video");

    for (const video of videos) {
      const variants = this.collectVideoVariants(video);
      if (variants.length === 0) continue;

      const best = selectBestVariant(variants);
      if (!best) continue;

      const source = this.detectSource(video);
      const album = this.detectAlbum(video);
      const item = this.buildVideoItem(
        best.url,
        best.width,
        best.height,
        best.bitrate,
        video.duration,
        source,
        album,
        variants
      );

      if (item && !this.seenIds.has(item.id)) {
        this.seenIds.add(item.id);
        items.push(item);
      }
    }

    return items;
  }

  private extractFromVideoLinks(): MediaItem[] {
    const items: MediaItem[] = [];
    const links = document.querySelectorAll<HTMLAnchorElement>("a[href]");

    for (const link of links) {
      const href = link.href;
      if (!href) continue;

      if (/\/video[s]\/\?/.test(href) || /\/reel[s]\/\?/.test(href)) {
        const poster = link.querySelector("img");
        const thumbnailUrl = poster?.src;

        const source = /reel/.test(href) ? "reel" : "uploaded";
        const album = this.detectAlbum(link);

        const item = this.buildVideoItem(href, 0, 0, undefined, undefined, source, album, [], thumbnailUrl);

        if (item && !this.seenIds.has(item.id)) {
          this.seenIds.add(item.id);
          items.push(item);
        }
      }
    }

    return items;
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  private collectImageVariants(img: HTMLImageElement): MediaVariant[] {
    const variants: MediaVariant[] = [];

    // src
    if (img.src && this.isFacebookMediaUrl(img.src)) {
      variants.push({
        url: img.src,
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        type: "photo",
      });
    }

    // srcset
    if (img.srcset) {
      const entries = img.srcset.split(",").map((s) => s.trim());
      for (const entry of entries) {
        const parts = entry.split(/\s+/);
        const url = parts[0];
        const descriptor = parts[1] || "";
        if (!url || !this.isFacebookMediaUrl(url)) continue;

        let w = 0;
        let h = 0;
        const wMatch = descriptor.match(/(\d+)w/);
        if (wMatch) w = parseInt(wMatch[1], 10);
        const hMatch = descriptor.match(/(\d+)h/);
        if (hMatch) h = parseInt(hMatch[1], 10);

        variants.push({ url, width: w, height: h, type: "photo" });
      }
    }

    // data attributes
    for (const attr of ["data-src", "data-hqsrc", "data-fullsrc", "data-bigsrc"]) {
      const url = img.getAttribute(attr);
      if (url && this.isFacebookMediaUrl(url)) {
        variants.push({ url, width: 0, height: 0, type: "photo" });
      }
    }

    return variants;
  }

  private collectVideoVariants(video: HTMLVideoElement): MediaVariant[] {
    const variants: MediaVariant[] = [];

    // Main src
    if (video.src && this.isFacebookMediaUrl(video.src)) {
      variants.push({
        url: video.src,
        width: video.videoWidth,
        height: video.videoHeight,
        type: "video",
      });
    }

    // Source elements
    const sources = video.querySelectorAll<HTMLSourceElement>("source");
    for (const source of sources) {
      if (source.src && this.isFacebookMediaUrl(source.src)) {
        const parsed = parseVideoSource(source.src);
        variants.push({
          url: source.src,
          width: video.videoWidth,
          height: video.videoHeight,
          quality: parsed?.quality === "hd" ? 720 : parsed?.quality === "fhd" ? 1080 : 480,
          type: "video",
        });
      }
    }

    // Data attributes
    for (const attr of ["data-src", "data-hd-src", "data-sd-src"]) {
      const url = video.getAttribute(attr);
      if (url && this.isFacebookMediaUrl(url)) {
        const parsed = parseVideoSource(url);
        variants.push({
          url,
          width: video.videoWidth,
          height: video.videoHeight,
          quality: parsed?.quality === "hd" ? 720 : parsed?.quality === "fhd" ? 1080 : 480,
          type: "video",
        });
      }
    }

    return variants;
  }

  private detectSource(element: Element): MediaSource {
    const parent = element.closest("[data-testid], [role='article'], [role='dialog']");

    // Check URL context
    const closestLink = element.closest("a[href]");
    const href = closestLink?.getAttribute("href") ?? "";

    if (/\/photo[s]\/\?fbid=/.test(href)) return "album";
    if (/\/tagged/.test(window.location.href)) return "tagged";
    if (/\/photos/.test(window.location.href)) return "timeline";
    if (/\/videos/.test(window.location.href)) return "uploaded";
    if (/\/reel[s]/.test(href) || /\/reel[s]/.test(window.location.href)) return "reel";

    // Check parent context
    const testId = parent?.getAttribute("data-testid") ?? "";
    if (/photo/.test(testId)) return "timeline";

    // Check for profile/cover indicators
    const ariaLabel = element.getAttribute("aria-label")?.toLowerCase() ?? "";
    if (/cover photo/.test(ariaLabel)) return "cover";
    if (/profile picture/.test(ariaLabel)) return "profile";

    return "unknown";
  }

  private detectAlbum(element: Element): string {
    // Try to find album name from context
    const article = element.closest("[role='article']");

    // Check for album indicators
    const albumLink = article?.querySelector('a[href*="/albums/"], a[href*="/photos/"]');
    if (albumLink) {
      return albumLink.textContent?.trim() || "Album";
    }

    // Check for "added X photos to the album Y" text
    const allText = article?.textContent ?? "";
    const albumMatch = allText.match(/(?:added|uploaded)\s+\d+\s+photos?\s+to\s+(?:the\s+)?(?:album\s+)?["""]?([^""",]+)["""]?/i);
    if (albumMatch) return albumMatch[1].trim();

    // Default album based on page
    const path = window.location.pathname;
    if (/\/photos/.test(path)) return "Timeline Photos";
    if (/\/videos/.test(path)) return "Videos";
    if (/\/albums/.test(path)) return "Albums";
    if (/\/tagged/.test(path)) return "Tagged Photos";

    return "General";
  }

  private buildPhotoItem(
    url: string,
    width: number,
    height: number,
    source: MediaSource,
    album: string,
    variants?: MediaVariant[]
  ): MediaItem | null {
    if (!url || !this.isFacebookMediaUrl(url)) return null;

    mediaIndex++;
    const id = `photo_${generateFingerprint(url, width, height)}`;

    return {
      id,
      type: "photo",
      source,
      url,
      filename: buildFilename(url, "photo", album, mediaIndex),
      width,
      height,
      album,
      date: new Date().toISOString(),
      downloaded: false,
      allVariants: variants,
    };
  }

  private buildVideoItem(
    url: string,
    width: number,
    height: number,
    bitrate?: number,
    duration?: number,
    source?: MediaSource,
    album?: string,
    variants?: MediaVariant[],
    thumbnailUrl?: string
  ): MediaItem | null {
    if (!url) return null;

    mediaIndex++;
    const id = `video_${generateFingerprint(url, width, height)}`;

    return {
      id,
      type: "video",
      source: source ?? "unknown",
      url,
      filename: buildFilename(url, "video", album ?? "Videos", mediaIndex),
      width,
      height,
      album: album ?? "Videos",
      date: new Date().toISOString(),
      downloaded: false,
      thumbnailUrl,
      bitrate,
      duration,
      allVariants: variants,
    };
  }

  private isFacebookMediaUrl(url: string): boolean {
    try {
      const u = new URL(url);
      return isFacebookCdn(u.hostname) || u.hostname.includes("facebook.com");
    } catch {
      return false;
    }
  }
}
