import type { MediaType, MediaVariant } from "../types";

/**
 * Try to upgrade a Facebook CDN image URL to the highest available quality.
 *
 * Facebook CDN URLs follow patterns like:
 *   /v/t39.30808-6/{id}_n.jpg   (normal)
 *   /v/t39.30808-6/{id}_s.jpg   (small)
 *   /v/t39.30808-6/{id}_o.jpg   (original / full resolution)
 *   /v/t39.30808-6/{id}.jpg     (no suffix = usually full)
 *
 * Strategy: try suffixes in quality order: _o, _n, original (no suffix).
 * We return the best candidate URLs for the caller to verify.
 */
export function getFacebookQualityUrls(url: string): string[] {
  const candidates: string[] = [url]; // always include original

  try {
    const u = new URL(url);

    // Match CDN path pattern: .../{id}_{suffix}.{ext}
    const pathMatch = u.pathname.match(/(\/v\/[^/]+\/[^/]+)_([a-z])\.(\w{3,4})$/);
    if (!pathMatch) return candidates;

    const [, base, _currentSuffix, ext] = pathMatch;

    // Try higher quality suffixes first
    const qualitySuffixes = ["o", "n", "p", "q"];
    for (const suffix of qualitySuffixes) {
      const newUrl = `${base}_${suffix}.${ext}${u.search}`;
      if (newUrl !== url) {
        candidates.push(newUrl);
      }
    }

    // Also try without any suffix (sometimes the full image)
    const noSuffixUrl = `${base}.${ext}${u.search}`;
    if (!candidates.includes(noSuffixUrl)) {
      candidates.push(noSuffixUrl);
    }
  } catch {
    // Not a valid URL, return as-is
  }

  return candidates;
}

/**
 * Generate a stable fingerprint for a media item using its URL and dimensions.
 */
export function generateFingerprint(url: string, width: number, height: number): string {
  const normalized = `${normalizeUrl(url)}|${width}x${height}`;
  return simpleHash(normalized);
}

/**
 * Simple non-crypto hash (djb2) for fingerprinting. Good enough for dedup.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Normalize a URL by removing query params that don't affect the resource,
 * and stripping resize/crop suffixes added by Facebook CDN.
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Remove Facebook resize/crop query params
    const keepParams = new Set(["fbid", "id"]);
    const params = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (keepParams.has(k)) params.set(k, v);
    }
    // Strip path suffixes like _o.jpg, _n.jpg
    u.pathname = u.pathname.replace(/_[a-z](\.(jpg|png|webp|gif))$/i, "$1");
    u.search = params.toString();
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Parse an image URL and extract resolution information from CDN URL patterns.
 */
export function parseImageUrl(url: string): MediaVariant | null {
  try {
    const u = new URL(url);

    // Detect Facebook CDN image
    if (!isFacebookCdn(u.hostname) && !isInstagramCdn(u.hostname)) return null;

    // Try to extract dimensions from URL patterns
    const dimMatch = u.pathname.match(/(\d+)x(\d+)/);
    const width = dimMatch ? parseInt(dimMatch[1], 10) : 0;
    const height = dimMatch ? parseInt(dimMatch[2], 10) : 0;

    return {
      url,
      width,
      height,
      type: "photo",
    };
  } catch {
    return null;
  }
}

/**
 * Select the highest resolution variant from a list.
 */
export function selectBestVariant(variants: MediaVariant[]): MediaVariant | null {
  if (variants.length === 0) return null;

  return variants.reduce((best, current) => {
    const bestScore = variantScore(best);
    const currentScore = variantScore(current);
    if (currentScore > bestScore) return current;
    return best;
  });
}

function variantScore(v: MediaVariant): number {
  // Use width if height is 0 (from srcset with width-only descriptors)
  const w = v.width || 0;
  const h = v.height || 0;
  if (w > 0 && h === 0) {
    // Width-only: treat width as a proxy for quality
    return w * w; // Square it to heavily prefer larger widths
  }
  return w * h;
}

/**
 * Parse a Facebook CDN URL to determine if it's a high-quality image.
 * Returns true if the URL pattern indicates original or full-resolution.
 */
export function isHighQualityUrl(url: string): boolean {
  // Low-quality indicators in FB CDN
  const lowQualityPatterns = [
    /_[sp]\d+x\d+/,
    /\/s\d+x\d+\//,
    /\/c\d+\.\d+\.\d+\.\d+\//,
    /\/p\d+x\d+/,
    /_small/,
    /_thumb/,
    /\/thumbnail\//,
    /\/icon\//,
    /\/avatar\//,
  ];

  return !lowQualityPatterns.some((p) => p.test(url));
}

/**
 * Determine the best image URL from a set of srcset-like sources.
 */
export function resolveBestImageUrl(sources: string[]): string {
  if (sources.length === 0) return "";
  if (sources.length === 1) return sources[0];

  const parsed = sources
    .map((url) => ({ url, variant: parseImageUrl(url) }))
    .filter((p): p is { url: string; variant: MediaVariant } => p.variant !== null);

  if (parsed.length === 0) return sources[0];

  const best = selectBestVariant(parsed.map((p) => ({ ...p.variant!, url: p.url })));
  return best?.url ?? sources[0];
}

/**
 * Extract all possible image URLs from a DOM element's attributes and styles.
 */
export function extractUrlsFromElement(el: HTMLElement): string[] {
  const urls: string[] = [];

  // src attribute
  if (el instanceof HTMLImageElement) {
    if (el.src) urls.push(el.src);
    if (el.dataset.src) urls.push(el.dataset.src);
    if (el.srcset) {
      urls.push(...el.srcset.split(",").map((s) => s.trim().split(/\s+/)[0]));
    }
  }

  // background-image
  const bg = el.style.backgroundImage;
  if (bg && bg !== "none") {
    const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (match) urls.push(match[1]);
  }

  // data attributes commonly used by FB
  const dataAttrs = ["data-src", "data-bigsrc", "data-hqsrc", "data-fullsrc"];
  for (const attr of dataAttrs) {
    const val = el.getAttribute(attr);
    if (val) urls.push(val);
  }

  return urls.filter((u) => {
    try {
      new URL(u);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Parse video source URLs from various formats.
 */
export function parseVideoSource(src: string): { url: string; quality: string } | null {
  if (!src) return null;

  try {
    const u = new URL(src);
    let quality = "unknown";

    if (/720|hd|high/i.test(src)) quality = "hd";
    else if (/1080|fhd/i.test(src)) quality = "fhd";
    else if (/480|sd/i.test(src)) quality = "sd";
    else if (/360/i.test(src)) quality = "360p";
    else if (/240/i.test(src)) quality = "240p";

    return { url: u.toString(), quality };
  } catch {
    return null;
  }
}

export function isFacebookCdn(hostname: string): boolean {
  return (
    hostname.endsWith(".fbcdn.net") ||
    hostname === "fbcdn.net" ||
    hostname.endsWith(".facebook.com") ||
    hostname.endsWith(".cdninstagram.com")
  );
}

export function isInstagramCdn(hostname: string): boolean {
  return hostname.endsWith(".cdninstagram.com") || hostname === "instagram.com";
}

/**
 * Build a clean filename from a URL and metadata.
 */
export function buildFilename(
  url: string,
  type: MediaType,
  album: string,
  index: number
): string {
  let ext = "jpg";
  try {
    const u = new URL(url);
    const pathMatch = u.pathname.match(/\.(\w{3,4})(?:\?|$)/);
    if (pathMatch) ext = pathMatch[1].toLowerCase();
    // Map common CDN extensions
    if (ext === "jpeg") ext = "jpg";
    if (ext === "webp" && type === "photo") ext = "jpg";
  } catch {
    // ignore
  }

  const albumSlug = album
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 50);

  const prefix = type === "photo" ? "photo" : "video";
  const padded = String(index).padStart(5, "0");

  return albumSlug ? `${albumSlug}_${prefix}_${padded}.${ext}` : `${prefix}_${padded}.${ext}`;
}

/**
 * Sanitize a filename for filesystem use.
 */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 200);
}
