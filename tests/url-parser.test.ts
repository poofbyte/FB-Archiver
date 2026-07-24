import { describe, it, expect } from "vitest";
import { generateFingerprint, buildFilename, sanitizeFilename, normalizeUrl, isFacebookCdn, isHighQualityUrl, parseVideoSource, resolveBestImageUrl } from "../src/utils/url-parser";

describe("generateFingerprint", () => {
  it("generates a consistent fingerprint for the same inputs", () => {
    const fp1 = generateFingerprint("https://example.com/image.jpg", 100, 200);
    const fp2 = generateFingerprint("https://example.com/image.jpg", 100, 200);
    expect(fp1).toBe(fp2);
  });

  it("generates different fingerprints for different URLs", () => {
    const fp1 = generateFingerprint("https://example.com/a.jpg", 100, 200);
    const fp2 = generateFingerprint("https://example.com/b.jpg", 100, 200);
    expect(fp1).not.toBe(fp2);
  });

  it("generates different fingerprints for different dimensions", () => {
    const fp1 = generateFingerprint("https://example.com/a.jpg", 100, 200);
    const fp2 = generateFingerprint("https://example.com/a.jpg", 200, 100);
    expect(fp1).not.toBe(fp2);
  });
});

describe("normalizeUrl", () => {
  it("strips CDN resize suffixes", () => {
    const result = normalizeUrl("https://example.com/image_o.jpg?v=123");
    expect(result).toContain("image.jpg");
    expect(result).not.toContain("_o.jpg");
  });

  it("preserves fbid and id params", () => {
    const result = normalizeUrl("https://example.com/image.jpg?fbid=123&id=456&other=789");
    expect(result).toContain("fbid=123");
    expect(result).toContain("id=456");
    expect(result).not.toContain("other=789");
  });

  it("handles invalid URLs gracefully", () => {
    expect(normalizeUrl("not-a-url")).toBe("not-a-url");
  });
});

describe("buildFilename", () => {
  it("builds a filename with album prefix", () => {
    const name = buildFilename("https://example.com/photo.jpg", "photo", "Vacation 2024", 1);
    expect(name).toContain("vacation_2024");
    expect(name).toContain("photo_");
    expect(name).toMatch(/\.jpg$/);
  });

  it("pads index with zeros", () => {
    const name = buildFilename("https://example.com/photo.jpg", "photo", "Album", 5);
    expect(name).toContain("00005");
  });

  it("handles video type", () => {
    const name = buildFilename("https://example.com/video.mp4", "video", "Videos", 1);
    expect(name).toContain("video_");
    expect(name).toMatch(/\.mp4$/);
  });
});

describe("sanitizeFilename", () => {
  it("removes illegal characters", () => {
    const result = sanitizeFilename('My <File> "Name" : Test | Path? *Star*');
    expect(result).not.toMatch(/[<>:"/\\|?*]/);
  });

  it("collapses multiple underscores", () => {
    const result = sanitizeFilename("my___file");
    expect(result).not.toMatch(/___/);
  });

  it("truncates to 200 chars", () => {
    const longName = "a".repeat(300);
    const result = sanitizeFilename(longName);
    expect(result.length).toBeLessThanOrEqual(200);
  });
});

describe("isFacebookCdn", () => {
  it("recognizes fbcdn.net", () => {
    expect(isFacebookCdn("scontent.fbcdn.net")).toBe(true);
    expect(isFacebookCdn("fbcdn.net")).toBe(true);
  });

  it("recognizes facebook.com", () => {
    expect(isFacebookCdn("www.facebook.com")).toBe(true);
    expect(isFacebookCdn("static.facebook.com")).toBe(true);
  });

  it("recognizes cdninstagram.com", () => {
    expect(isFacebookCdn("scontent.cdninstagram.com")).toBe(true);
  });

  it("rejects non-Facebook domains", () => {
    expect(isFacebookCdn("example.com")).toBe(false);
    expect(isFacebookCdn("google.com")).toBe(false);
  });
});

describe("isHighQualityUrl", () => {
  it("identifies low quality URLs", () => {
    expect(isHighQualityUrl("https://example.com/s100x100/photo.jpg")).toBe(false);
    expect(isHighQualityUrl("https://example.com/photo_thumb.jpg")).toBe(false);
    expect(isHighQualityUrl("https://example.com/photo_small.jpg")).toBe(false);
  });

  it("identifies high quality URLs", () => {
    expect(isHighQualityUrl("https://example.com/photo.jpg")).toBe(true);
    expect(isHighQualityUrl("https://example.com/2048x2048/photo.jpg")).toBe(true);
  });
});

describe("parseVideoSource", () => {
  it("parses HD video URLs", () => {
    const result = parseVideoSource("https://example.com/video_720p.mp4");
    expect(result).not.toBeNull();
    expect(result!.quality).toBe("hd");
  });

  it("parses FHD video URLs", () => {
    const result = parseVideoSource("https://example.com/video_1080p.mp4");
    expect(result).not.toBeNull();
    expect(result!.quality).toBe("fhd");
  });

  it("returns null for empty input", () => {
    expect(parseVideoSource("")).toBeNull();
  });
});

describe("resolveBestImageUrl", () => {
  it("returns the single URL when only one source", () => {
    const result = resolveBestImageUrl(["https://example.com/photo.jpg"]);
    expect(result).toBe("https://example.com/photo.jpg");
  });

  it("returns empty string for empty input", () => {
    expect(resolveBestImageUrl([])).toBe("");
  });
});
