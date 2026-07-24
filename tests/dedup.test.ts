import { describe, it, expect, beforeEach } from "vitest";
import { DuplicateDetector } from "../src/utils/dedup";
import type { MediaItem } from "../src/types";

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "photo_test_1",
    type: "photo",
    source: "timeline",
    url: "https://scontent.fbcdn.net/test/photo.jpg",
    filename: "photo_00001.jpg",
    width: 1080,
    height: 1080,
    album: "Timeline Photos",
    date: "2024-01-01T00:00:00Z",
    downloaded: false,
    ...overrides,
  };
}

describe("DuplicateDetector", () => {
  let detector: DuplicateDetector;

  beforeEach(() => {
    detector = new DuplicateDetector();
  });

  it("detects duplicate by ID", () => {
    const item = makeItem({ id: "photo_1" });
    detector.add(item);

    expect(detector.isDuplicate(makeItem({ id: "photo_1" }))).toBe(true);
  });

  it("detects duplicate by URL", () => {
    const item = makeItem({ id: "photo_1", url: "https://fbcdn.net/a.jpg" });
    detector.add(item);

    expect(
      detector.isDuplicate(makeItem({ id: "photo_2", url: "https://fbcdn.net/a.jpg" }))
    ).toBe(true);
  });

  it("does not flag different items as duplicates", () => {
    detector.add(makeItem({ id: "photo_1", url: "https://fbcdn.net/a.jpg" }));

    expect(
      detector.isDuplicate(makeItem({ id: "photo_2", url: "https://fbcdn.net/b.jpg" }))
    ).toBe(false);
  });

  it("filterUnique removes duplicates", () => {
    const items = [
      makeItem({ id: "photo_1", url: "https://fbcdn.net/a.jpg" }),
      makeItem({ id: "photo_2", url: "https://fbcdn.net/b.jpg" }),
      makeItem({ id: "photo_1", url: "https://fbcdn.net/a.jpg" }), // duplicate
      makeItem({ id: "photo_3", url: "https://fbcdn.net/c.jpg" }),
    ];

    const unique = detector.filterUnique(items);
    expect(unique).toHaveLength(3);
  });

  it("reset clears all indexes", () => {
    detector.add(makeItem({ id: "photo_1" }));
    detector.reset();

    expect(detector.getCounts()).toEqual({
      urls: 0,
      fingerprints: 0,
      ids: 0,
    });
  });

  it("tracks variant URLs for dedup", () => {
    const item = makeItem({
      id: "photo_1",
      allVariants: [
        { url: "https://fbcdn.net/a_v1.jpg", width: 500, height: 500, type: "photo" },
        { url: "https://fbcdn.net/a_v2.jpg", width: 1000, height: 1000, type: "photo" },
      ],
    });
    detector.add(item);

    expect(
      detector.isDuplicate(
        makeItem({
          id: "photo_2",
          url: "https://fbcdn.net/a_v2.jpg",
        })
      )
    ).toBe(true);
  });
});
