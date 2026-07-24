import type { MediaItem, SessionState, DownloadItem, Settings } from "../types";
import { logger } from "../utils/logger";

const DB_NAME = "fb-media-archiver";
const DB_VERSION = 1;

const STORES = {
  MEDIA: "media",
  DOWNLOADS: "downloads",
  SESSIONS: "sessions",
  SETTINGS: "settings",
} as const;

class IndexedDBService {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Media store
        if (!db.objectStoreNames.contains(STORES.MEDIA)) {
          const mediaStore = db.createObjectStore(STORES.MEDIA, { keyPath: "id" });
          mediaStore.createIndex("type", "type", { unique: false });
          mediaStore.createIndex("album", "album", { unique: false });
          mediaStore.createIndex("downloaded", "downloaded", { unique: false });
          mediaStore.createIndex("url", "url", { unique: false });
          mediaStore.createIndex("date", "date", { unique: false });
        }

        // Downloads store
        if (!db.objectStoreNames.contains(STORES.DOWNLOADS)) {
          const dlStore = db.createObjectStore(STORES.DOWNLOADS, { keyPath: "id" });
          dlStore.createIndex("mediaId", "mediaId", { unique: false });
          dlStore.createIndex("status", "status", { unique: false });
        }

        // Sessions store
        if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
          const sessStore = db.createObjectStore(STORES.SESSIONS, { keyPath: "currentUrl" });
          sessStore.createIndex("startedAt", "startedAt", { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains(STORES.SETTINGS)) {
          db.createObjectStore(STORES.SETTINGS, { keyPath: "key" });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        logger.info("IndexedDB initialized successfully");
        resolve();
      };

      request.onerror = (event) => {
        const error = (event.target as IDBOpenDBRequest).error;
        logger.error("IndexedDB initialization failed", error);
        reject(error);
      };
    });
  }

  private ensureDb(): IDBDatabase {
    if (!this.db) throw new Error("IndexedDB not initialized. Call init() first.");
    return this.db;
  }

  private transaction(storeName: string, mode: IDBTransactionMode): IDBObjectStore {
    const db = this.ensureDb();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  /* ── Media Operations ────────────────────────────────────────────────── */

  async addMedia(item: MediaItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.MEDIA, "readwrite");
      const request = store.put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async addMediaBatch(items: MediaItem[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const db = this.ensureDb();
      const tx = db.transaction(STORES.MEDIA, "readwrite");
      const store = tx.objectStore(STORES.MEDIA);

      for (const item of items) {
        store.put(item);
      }

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getMedia(id: string): Promise<MediaItem | undefined> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.MEDIA, "readonly");
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllMedia(): Promise<MediaItem[]> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.MEDIA, "readonly");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getMediaByType(type: MediaItem["type"]): Promise<MediaItem[]> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.MEDIA, "readonly");
      const index = store.index("type");
      const request = index.getAll(type);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getUndownloadedMedia(): Promise<MediaItem[]> {
    const all = await this.getAllMedia();
    return all.filter((m) => !m.downloaded);
  }

  async updateMedia(item: MediaItem): Promise<void> {
    return this.addMedia(item);
  }

  async markDownloaded(id: string, path: string): Promise<void> {
    const item = await this.getMedia(id);
    if (item) {
      item.downloaded = true;
      item.downloadPath = path;
      await this.addMedia(item);
    }
  }

  async getMediaCount(): Promise<{ total: number; photos: number; videos: number; downloaded: number }> {
    const all = await this.getAllMedia();
    return {
      total: all.length,
      photos: all.filter((m) => m.type === "photo").length,
      videos: all.filter((m) => m.type === "video").length,
      downloaded: all.filter((m) => m.downloaded).length,
    };
  }

  async clearMedia(): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.MEDIA, "readwrite");
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /* ── Download Operations ─────────────────────────────────────────────── */

  async addDownload(item: DownloadItem): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.DOWNLOADS, "readwrite");
      const request = store.put(item);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getDownload(id: string): Promise<DownloadItem | undefined> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.DOWNLOADS, "readonly");
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllDownloads(): Promise<DownloadItem[]> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.DOWNLOADS, "readonly");
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getDownloadsByStatus(status: DownloadItem["status"]): Promise<DownloadItem[]> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.DOWNLOADS, "readonly");
      const index = store.index("status");
      const request = index.getAll(status);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async updateDownload(item: DownloadItem): Promise<void> {
    return this.addDownload(item);
  }

  async clearDownloads(): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.DOWNLOADS, "readwrite");
      const request = store.clear();
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /* ── Session Operations ──────────────────────────────────────────────── */

  async saveSession(state: SessionState): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.SESSIONS, "readwrite");
      const request = store.put(state);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getSession(url: string): Promise<SessionState | undefined> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.SESSIONS, "readonly");
      const request = store.get(url);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getLastSession(): Promise<SessionState | undefined> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.SESSIONS, "readonly");
      const index = store.index("startedAt");
      const request = index.openCursor(null, "prev");
      request.onsuccess = () => {
        const cursor = request.result;
        resolve(cursor?.value);
      };
      request.onerror = () => reject(request.error);
    });
  }

  /* ── Settings Operations ─────────────────────────────────────────────── */

  async saveSetting(key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.SETTINGS, "readwrite");
      const request = store.put({ key, value });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const store = this.transaction(STORES.SETTINGS, "readonly");
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value as T);
      request.onerror = () => reject(request.error);
    });
  }

  async saveSettings(settings: Settings): Promise<void> {
    return this.saveSetting("appSettings", settings);
  }

  async getSettings(): Promise<Settings> {
    const defaults: Settings = {
      scrollSpeed: 400,
      concurrentDownloads: 3,
      retryCount: 5,
      maxMediaCount: 0,
      autoResume: true,
      autoExport: true,
      autoZip: true,
      zipSuffixPhotos: "_photos",
      zipSuffixVideos: "_videos",
      downloadLocation: "",
    };
    const saved = await this.getSetting<Settings>("appSettings");
    return saved ?? defaults;
  }

  /* ── Cleanup ─────────────────────────────────────────────────────────── */

  async clearAll(): Promise<void> {
    await this.clearMedia();
    await this.clearDownloads();
    logger.info("All IndexedDB data cleared");
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

export const db = new IndexedDBService();
