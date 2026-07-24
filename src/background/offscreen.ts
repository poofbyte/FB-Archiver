/**
 * Offscreen document for ZIP creation.
 * MV3 service workers can't use Blob/URL.createObjectURL, so this page
 * handles fetching files from CDN, creating ZIP archives via JSZip,
 * and triggering downloads — all with full DOM API access.
 */
import JSZip from "jszip";

interface FileEntry {
  url: string;
  filename: string;
  album: string;
}

chrome.runtime.onMessage.addListener(
  (message: { action: string; payload?: Record<string, unknown> }, _sender, sendResponse) => {
    if (message.action === "OFFSCREEN_CREATE_ZIP") {
      handleCreateZip(message.payload)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => {
          console.error("[Offscreen] ZIP creation failed:", err);
          sendResponse({ success: false, error: String(err) });
        });
      return true; // async response
    }
  }
);

async function handleCreateZip(payload: Record<string, unknown> | undefined): Promise<string> {
  const files = payload?.files as FileEntry[] | undefined;
  const zipName = payload?.zipName as string;

  if (!files || files.length === 0 || !zipName) {
    throw new Error("Invalid payload: missing files or zipName");
  }

  console.log(`[Offscreen] Starting ZIP creation: ${zipName} (${files.length} files)`);
  const zip = new JSZip();
  let addedCount = 0;
  let failedCount = 0;

  // Fetch in batches of 3 to avoid overwhelming
  const BATCH = 3;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const albumSlug = (file.album || "General")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_|_$/g, "")
          .slice(0, 50);
        const path = `${albumSlug}/${file.filename}`;

        // Fetch with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const response = await fetch(file.url, { signal: controller.signal });
          clearTimeout(timeout);

          if (!response.ok) {
            console.warn(`[Offscreen] HTTP ${response.status}: ${file.filename}`);
            return null;
          }

          const blob = await response.blob();
          return { path, blob };
        } catch (err) {
          clearTimeout(timeout);
          console.warn(`[Offscreen] Fetch failed: ${file.filename} - ${err}`);
          return null;
        }
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        zip.file(result.value.path, result.value.blob);
        addedCount++;
      } else {
        failedCount++;
      }
    }

    console.log(`[Offscreen] Progress: ${Math.min(i + BATCH, files.length)}/${files.length}`);
  }

  console.log(`[Offscreen] Fetched ${addedCount}/${files.length} files (${failedCount} failed)`);

  if (addedCount === 0) {
    throw new Error("No files could be fetched");
  }

  // Generate ZIP
  console.log(`[Offscreen] Generating ZIP...`);
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Create object URL and trigger download
  const url = URL.createObjectURL(blob);
  console.log(`[Offscreen] ZIP ready (${(blob.size / 1024 / 1024).toFixed(1)} MB), triggering download...`);

  await chrome.downloads.download({
    url,
    filename: zipName,
    saveAs: true,
  });

  // Revoke after download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return zipName;
}
