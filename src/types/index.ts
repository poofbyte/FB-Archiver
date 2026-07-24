/* ── Media Types ─────────────────────────────────────────────────────────── */

export type MediaType = "photo" | "video";

export type MediaSource =
  | "timeline"
  | "album"
  | "tagged"
  | "cover"
  | "profile"
  | "shared"
  | "uploaded"
  | "reel"
  | "unknown";

export interface MediaItem {
  id: string;
  type: MediaType;
  source: MediaSource;
  url: string;
  filename: string;
  width: number;
  height: number;
  album: string;
  date: string;
  downloaded: boolean;
  downloadPath?: string;
  thumbnailUrl?: string;
  title?: string;
  duration?: number;
  size?: number;
  bitrate?: number;
  allVariants?: MediaVariant[];
}

export interface MediaVariant {
  url: string;
  width: number;
  height: number;
  quality?: number;
  bitrate?: number;
  type: MediaType;
}

/* ── Download Types ──────────────────────────────────────────────────────── */

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "completed"
  | "failed"
  | "paused"
  | "cancelled";

export interface DownloadItem {
  id: string;
  mediaId: string;
  url: string;
  filename: string;
  status: DownloadStatus;
  progress: number;
  retryCount: number;
  error?: string;
  downloadId?: number;
  startedAt?: number;
  completedAt?: number;
  byteReceived?: number;
  totalBytes?: number;
  downloadPath?: string;
}

/* ── Session Types ───────────────────────────────────────────────────────── */

export interface SessionState {
  lastPosition: number;
  totalFound: number;
  totalDownloaded: number;
  isRunning: boolean;
  isPaused: boolean;
  currentUrl: string;
  startedAt: number;
  scrollPosition: number;
}

/* ── Settings Types ──────────────────────────────────────────────────────── */

export interface Settings {
  scrollSpeed: number;
  concurrentDownloads: number;
  retryCount: number;
  maxMediaCount: number;
  autoResume: boolean;
  autoExport: boolean;
  autoZip: boolean;
  zipSuffixPhotos: string;
  zipSuffixVideos: string;
  downloadLocation: string;
}

export const DEFAULT_SETTINGS: Settings = {
  scrollSpeed: 400,
  concurrentDownloads: 3,
  retryCount: 5,
  maxMediaCount: 0, // 0 = unlimited
  autoResume: true,
  autoExport: true,
  autoZip: true,
  zipSuffixPhotos: "_photos",
  zipSuffixVideos: "_videos",
  downloadLocation: "",
};

/* ── Progress Types ──────────────────────────────────────────────────────── */

export interface ProgressInfo {
  totalFound: number;
  totalDownloaded: number;
  totalRemaining: number;
  totalFailed: number;
  photosFound: number;
  videosFound: number;
  percentComplete: number;
  estimatedTimeRemaining: number;
  isRunning: boolean;
  isPaused: boolean;
  isDownloading: boolean;
}

/* ── Message Types ───────────────────────────────────────────────────────── */

export type MessageAction =
  | "START_SCAN"
  | "STOP_SCAN"
  | "PAUSE_SCAN"
  | "RESUME_SCAN"
  | "START_DOWNLOAD"
  | "PAUSE_DOWNLOAD"
  | "RESUME_DOWNLOAD"
  | "CANCEL_DOWNLOAD"
  | "GET_PROGRESS"
  | "GET_MEDIA"
  | "EXPORT_METADATA"
  | "CLEAR_DATABASE"
  | "SETTINGS_CHANGED"
  | "MEDIA_FOUND"
  | "DOWNLOAD_PROGRESS"
  | "SCAN_COMPLETE"
  | "DOWNLOAD_COMPLETE"
  | "DOWNLOAD_FAILED"
  | "SCROLL_PROGRESS";

export interface ExtensionMessage {
  action: MessageAction;
  payload?: unknown;
  tabId?: number;
}

export interface MessageResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

/* ── Scroll Types ────────────────────────────────────────────────────────── */

export interface ScrollConfig {
  speed: number;
  maxRetries: number;
  maxIdleIterations: number;
  scrollStepPixels: number;
}

/* ── Logger Types ────────────────────────────────────────────────────────── */

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
  data?: unknown;
}

/* ── Export Types ────────────────────────────────────────────────────────── */

export type ExportFormat = "json" | "csv";

export interface ExportOptions {
  format: ExportFormat;
  includeDownloaded: boolean;
  includeFailed: boolean;
  dateRange?: { start: string; end: string };
}
