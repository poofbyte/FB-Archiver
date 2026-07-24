# FB Media Archiver

A Chrome Extension for archiving your Facebook photos and videos at full resolution.

## Features

- **Smart Scrolling** — Automatically scrolls through pages to discover all media with MutationObserver and IntersectionObserver
- **Full Resolution Detection** — Always downloads the highest available quality (original/full-size images, HD video streams)
- **Deduplication** — Fingerprint-based dedup using URL normalization + content hashing to prevent duplicate downloads
- **Download Queue** — Concurrent downloads with pause/resume/cancel/retry and exponential backoff
- **ZIP Packaging** — Automatically packages downloaded photos and videos into separate ZIP archives
- **IndexedDB Storage** — Persistent metadata storage with resume-after-crash support
- **Export** — Export metadata as JSON or CSV
- **Progress Dashboard** — Real-time stats: found, downloaded, remaining, ETA

## Installation

### From Source (Developer Mode)

1. Clone or download this repository
2. Install dependencies and build:

```bash
npm install
npm run build
```

3. Open Chrome and navigate to `chrome://extensions/`
4. Enable **Developer mode** (toggle in top-right)
5. Click **Load unpacked**
6. Select the `dist/` folder from this project

### Manual Install (No Build)

If you just want to load the extension without building, you can load the `dist/` folder directly after a build.

## Usage

1. Log into your Facebook account in Chrome
2. Navigate to a media page (photos, videos, albums, tagged, etc.)
3. Click the extension icon in the toolbar
4. Click **Start Scan** to begin discovering media
5. Wait for scrolling to complete (the page auto-scrolls to load all content)
6. Review the count of photos/videos found
7. Click **Download All** to download everything
8. ZIP files are automatically created after download completes

### Supported Pages

- `facebook.com/username/photos` — Timeline photos
- `facebook.com/username/videos` — Uploaded videos
- `facebook.com/username/albums` — Photo albums
- `facebook.com/username/photos_of` — Tagged photos
- `facebook.com/username/reels` — Reels
- Any Facebook page with media content

### Media Types

| Type | Sources |
|------|---------|
| Photos | Timeline, albums, tagged, cover, profile, shared images |
| Videos | Uploaded, reels, timeline videos, album videos |

## Architecture

```
src/
├── types/              # TypeScript type definitions
├── utils/              # Utility functions (dedup, URL parsing, logging, export)
├── storage/            # IndexedDB service
├── services/           # Core business logic
│   ├── auto-scroller.ts        # Infinite scroll engine
│   ├── media-extractor.ts      # DOM-based media discovery
│   ├── media-resolver.ts       # Quality resolution
│   ├── download-manager.ts     # Chrome downloads API wrapper
│   ├── download-queue.ts       # Queue with concurrency control
│   ├── progress-tracker.ts     # Progress reporting
│   ├── resume-manager.ts       # Session persistence
│   └── zip-packager.ts         # ZIP creation with JSZip
├── content/            # Content scripts (injected into FB pages)
├── background/         # Service worker (MV3)
└── popup/              # Extension popup UI
```

### Key Classes

| Class | Purpose |
|-------|---------|
| `AutoScroller` | Smooth scrolling with MutationObserver, end-of-page detection, and retry logic |
| `MediaExtractor` | Multi-strategy DOM extraction (img elements, srcset, background-image, data attributes, links) |
| `MediaResolver` | Selects highest quality variant from discovered URLs |
| `DuplicateDetector` | URL normalization + content fingerprinting for dedup |
| `DownloadQueue` | Ordered download processing with concurrency control |
| `DownloadManager` | Chrome downloads API wrapper with retry/backoff |
| `ProgressTracker` | Real-time progress aggregation |
| `ResumeManager` | Session save/restore for crash recovery |
| `ZipPackager` | Album-organized ZIP creation using JSZip |
| `IndexedDBService` | Persistent storage for media, downloads, sessions, settings |

## Configuration

Access settings via the gear icon in the popup.

| Setting | Default | Description |
|---------|---------|-------------|
| Scroll Speed | 400ms | Delay between scroll steps |
| Concurrent Downloads | 3 | Maximum simultaneous downloads |
| Retry Count | 5 | Maximum retry attempts per failed download |
| Max Media Count | 0 (unlimited) | Stop scanning after finding this many items |
| Auto Resume | true | Resume unfinished downloads on restart |
| Auto Export | true | Export metadata JSON after downloads complete |
| Auto ZIP | true | Package files into ZIP archives |
| ZIP Suffix (Photos) | `_photos` | Suffix for photo ZIP filename |
| ZIP Suffix (Videos) | `_videos` | Suffix for video ZIP filename |

## Development

```bash
# Install dependencies
npm install

# Type check
npm run typecheck

# Run tests
npm test

# Build for production
npm run build

# Build in watch mode
npm run dev

# Lint
npm run lint

# Format
npm run format
```

## Data Storage

All data is stored locally in IndexedDB:

- **media** — Discovered media items with metadata
- **downloads** — Download queue and status
- **sessions** — Scroll position and session state for resume
- **settings** — User preferences

No data is sent to external servers. The extension only communicates with Facebook CDN URLs that you are authorized to access through your logged-in session.

## Permissions

| Permission | Purpose |
|------------|---------|
| `activeTab` | Communicate with the current Facebook tab |
| `downloads` | Download media files |
| `storage` | Persist settings and state |
| `offscreen` | ZIP creation in MV3 (service workers can't use Blob URLs) |
| `tabs` | Detect active tab and URL |
| `host_permissions` | Access Facebook CDN URLs for media downloads |

## Privacy

This extension is designed for **personal archival of media you own or have permission to download**. It:

- Does not bypass authentication or access controls
- Does not send data to third-party servers
- Works only within your active logged-in browser session
- Respects Facebook's terms of service

## License

MIT
