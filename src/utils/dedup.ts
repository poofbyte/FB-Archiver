import type { MediaItem } from "../types";
import { generateFingerprint } from "./url-parser";
import { logger } from "./logger";

/**
 * Deduplication engine using URL normalization and content fingerprinting.
 */
export class DuplicateDetector {
  private urlIndex = new Set<string>();
  private fingerprintIndex = new Set<string>();
  private idIndex = new Set<string>();

  reset(): void {
    this.urlIndex.clear();
    this.fingerprintIndex.clear();
    this.idIndex.clear();
  }

  /**
   * Check if a media item is a duplicate.
   */
  isDuplicate(item: MediaItem): boolean {
    // Check by ID
    if (this.idIndex.has(item.id)) return true;

    // Check by normalized URL
    const normalizedUrl = this.normalizeUrl(item.url);
    if (this.urlIndex.has(normalizedUrl)) return true;

    // Check by fingerprint (URL + dimensions)
    const fingerprint = generateFingerprint(item.url, item.width, item.height);
    if (this.fingerprintIndex.has(fingerprint)) return true;

    // Check all variants for duplicates
    if (item.allVariants) {
      for (const variant of item.allVariants) {
        const varUrl = this.normalizeUrl(variant.url);
        if (this.urlIndex.has(varUrl)) return true;
        const varFp = generateFingerprint(variant.url, variant.width, variant.height);
        if (this.fingerprintIndex.has(varFp)) return true;
      }
    }

    return false;
  }

  /**
   * Register a media item as seen.
   */
  add(item: MediaItem): void {
    this.idIndex.add(item.id);
    this.urlIndex.add(this.normalizeUrl(item.url));
    this.fingerprintIndex.add(generateFingerprint(item.url, item.width, item.height));

    if (item.allVariants) {
      for (const variant of item.allVariants) {
        this.urlIndex.add(this.normalizeUrl(variant.url));
        this.fingerprintIndex.add(generateFingerprint(variant.url, variant.width, variant.height));
      }
    }
  }

  /**
   * Filter a list of items, keeping only non-duplicates.
   */
  filterUnique(items: MediaItem[]): MediaItem[] {
    const unique: MediaItem[] = [];
    let dupCount = 0;

    for (const item of items) {
      if (!this.isDuplicate(item)) {
        this.add(item);
        unique.push(item);
      } else {
        dupCount++;
      }
    }

    if (dupCount > 0) {
      logger.info(`DuplicateDetector: filtered ${dupCount} duplicates from ${items.length} items`);
    }

    return unique;
  }

  /**
   * Get counts for diagnostics.
   */
  getCounts(): { urls: number; fingerprints: number; ids: number } {
    return {
      urls: this.urlIndex.size,
      fingerprints: this.fingerprintIndex.size,
      ids: this.idIndex.size,
    };
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      u.pathname = u.pathname.replace(/_[a-z]\.(jpg|png|webp|gif)$/i, "");
      // Keep only essential query params
      const keep = new Set(["fbid", "id"]);
      const params = new URLSearchParams();
      for (const [k, v] of u.searchParams) {
        if (keep.has(k)) params.set(k, v);
      }
      u.search = params.toString();
      return u.toString();
    } catch {
      return url;
    }
  }
}
