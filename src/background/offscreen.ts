/**
 * Offscreen document for operations requiring DOM APIs unavailable in MV3 service workers:
 * - Blob creation
 * - URL.createObjectURL
 * - ZIP file generation via JSZip
 */

// @ts-ignore - JSZip is bundled by esbuild/vite
import JSZip from "jszip";

chrome.runtime.onMessage.addListener(
  (message: { action: string; payload?: Record<string, unknown> }, _sender, sendResponse) => {
    if (message.action === "CREATE_ZIP_AND_DOWNLOAD") {
      handleCreateZip(message.payload)
        .then((result) => sendResponse({ success: true, data: result }))
        .catch((err) => sendResponse({ success: false, error: String(err) }));
      return true; // async
    }
  }
);

async function handleCreateZip(payload: Record<string, unknown> | undefined): Promise<string> {
  const entries = payload?.entries as Array<{ path: string; data: number[] }> | undefined;
  const zipName = payload?.zipName as string;

  if (!entries || entries.length === 0) {
    throw new Error("No entries provided");
  }

  const zip = new JSZip();

  // Add all files to the ZIP
  for (const entry of entries) {
    const buffer = new Uint8Array(entry.data).buffer;
    zip.file(entry.path, buffer);
  }

  // Generate the ZIP blob
  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  // Create object URL and trigger download
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: zipName,
      saveAs: true,
    });
    return zipName;
  } finally {
    // Revoke after a delay to ensure download starts
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}
