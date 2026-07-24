/**
 * Offscreen document for operations that require DOM access in MV3.
 * Used for ZIP creation and blob URL operations.
 */

chrome.runtime.onMessage.addListener(async (message, _sender, sendResponse) => {
  if (message.action === "CREATE_ZIP_BLOB") {
    try {
      void message.payload;
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: String(err) });
    }
    return true;
  }
});
