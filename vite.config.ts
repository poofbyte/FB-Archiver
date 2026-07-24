import { defineConfig } from "vite";
import { resolve } from "path";
import { writeFileSync, mkdirSync, cpSync, existsSync } from "fs";

const manifest = {
  manifest_version: 3,
  name: "FB Media Archiver",
  version: "1.0.0",
  description:
    "Archive your Facebook photos and videos with full resolution detection, smart scrolling, deduplication, and ZIP packaging.",
  permissions: [
    "activeTab",
    "downloads",
    "storage",
    "offscreen",
    "tabs",
  ],
  host_permissions: ["https://www.facebook.com/*", "https://*.facebook.com/*", "https://*.cdninstagram.com/*"],
  background: {
    service_worker: "src/background/service-worker.ts",
    type: "module",
  },
  action: {
    default_popup: "src/popup/popup.html",
    default_icon: {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png",
    },
  },
  icons: {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png",
  },
  content_scripts: [
    {
      matches: ["https://www.facebook.com/*", "https://*.facebook.com/*"],
      js: ["src/content/content-script.ts"],
      run_at: "document_idle",
    },
  ],
};

function copyIcons() {
  const src = resolve(__dirname, "public/icons");
  const dest = resolve(__dirname, "dist/icons");
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== "production",
    rollupOptions: {
      input: {
        "service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "content-script": resolve(__dirname, "src/content/content-script.ts"),
        popup: resolve(__dirname, "src/popup/popup.html"),
        offscreen: resolve(__dirname, "src/background/offscreen.html"),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === "service-worker") return "src/background/service-worker.js";
          if (chunkInfo.name === "content-script") return "src/content/content-script.js";
          if (chunkInfo.name === "offscreen") return "src/background/offscreen.js";
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith(".css")) {
            return assetInfo.name.includes("popup")
              ? "src/popup/popup.css"
              : "assets/[name][extname]";
          }
          return "assets/[name][extname]";
        },
      },
    },
    target: "esnext",
    minify: false,
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  plugins: [
    {
      name: "write-manifest",
      closeBundle() {
        writeFileSync(
          resolve(__dirname, "dist/manifest.json"),
          JSON.stringify(manifest, null, 2)
        );
        copyIcons();
      },
    },
  ],
});
