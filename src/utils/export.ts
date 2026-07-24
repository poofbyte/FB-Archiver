import type { MediaItem, ExportFormat } from "../types";
import { logger } from "./logger";

/**
 * Export media metadata in JSON or CSV format.
 */
export function exportMetadata(items: MediaItem[], format: ExportFormat): string {
  switch (format) {
    case "json":
      return exportJson(items);
    case "csv":
      return exportCsv(items);
  }
}

function exportJson(items: MediaItem[]): string {
  const exportData = {
    exportDate: new Date().toISOString(),
    totalItems: items.length,
    photos: items.filter((i) => i.type === "photo").length,
    videos: items.filter((i) => i.type === "video").length,
    items: items.map((item) => ({
      id: item.id,
      type: item.type,
      source: item.source,
      url: item.url,
      filename: item.filename,
      width: item.width,
      height: item.height,
      album: item.album,
      date: item.date,
      downloaded: item.downloaded,
      downloadPath: item.downloadPath,
      title: item.title,
      duration: item.duration,
      size: item.size,
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

function exportCsv(items: MediaItem[]): string {
  const headers = [
    "id",
    "type",
    "source",
    "url",
    "filename",
    "width",
    "height",
    "album",
    "date",
    "downloaded",
    "downloadPath",
    "title",
    "duration",
    "size",
  ];

  const rows = items.map((item) =>
    headers
      .map((h) => {
        const val = item[h as keyof MediaItem];
        if (val === undefined || val === null) return "";
        const str = String(val);
        // Escape CSV
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
          return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
      })
      .join(",")
  );

  return [headers.join(","), ...rows].join("\n");
}

/**
 * Trigger a download of the exported file via Chrome downloads API.
 */
export async function downloadExport(
  content: string,
  format: ExportFormat
): Promise<void> {
  const ext = format === "json" ? "json" : "csv";
  const mimeType = format === "json" ? "application/json" : "text/csv";
  const filename = `fb_media_export.${ext}`;

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename,
      saveAs: true,
    });
    logger.info(`Export downloaded: ${filename}`);
  } catch (err) {
    logger.error("Failed to download export", err);
    throw err;
  } finally {
    URL.revokeObjectURL(url);
  }
}
