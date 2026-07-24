import type { ScrollConfig } from "../types";
import { logger } from "../utils/logger";

const DEFAULT_SCROLL_CONFIG: ScrollConfig = {
  speed: 400,
  maxRetries: 3,
  maxIdleIterations: 10,
  scrollStepPixels: 800,
};

export class AutoScroller {
  private config: ScrollConfig;
  private isRunning = false;
  private isPaused = false;
  private shouldStop = false;
  private idleCount = 0;
  private lastHeight = 0;
  private totalScrolled = 0;
  private scrollTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: MutationObserver | null = null;
  private onProgress?: (info: {
    scrollHeight: number;
    scrollPosition: number;
    idleCount: number;
    mediaCount: number;
  }) => void;

  constructor(config?: Partial<ScrollConfig>) {
    this.config = { ...DEFAULT_SCROLL_CONFIG, ...config };
  }

  onProgressCallback(cb: typeof this.onProgress): void {
    this.onProgress = cb;
  }

  async start(_initialMediaCount = 0): Promise<void> {
    if (this.isRunning) {
      logger.warn("AutoScroller already running");
      return;
    }

    this.isRunning = true;
    this.isPaused = false;
    this.shouldStop = false;
    this.idleCount = 0;
    this.lastHeight = document.documentElement.scrollHeight;
    this.totalScrolled = 0;

    logger.info("AutoScroller started", {
      speed: this.config.speed,
      lastHeight: this.lastHeight,
    });

    // Set up MutationObserver for fast detection of new content
    this.setupObserver();

    await this.scrollLoop();
  }

  stop(): void {
    this.shouldStop = true;
    this.isRunning = false;
    this.cleanup();
    logger.info("AutoScroller stopped", {
      totalScrolled: this.totalScrolled,
      idleCount: this.idleCount,
    });
  }

  pause(): void {
    this.isPaused = true;
    logger.info("AutoScroller paused");
  }

  resume(): void {
    this.isPaused = false;
    logger.info("AutoScroller resumed");
  }

  getStats(): {
    isRunning: boolean;
    isPaused: boolean;
    scrollHeight: number;
    totalScrolled: number;
    idleCount: number;
  } {
    return {
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      scrollHeight: document.documentElement.scrollHeight,
      totalScrolled: this.totalScrolled,
      idleCount: this.idleCount,
    };
  }

  private setupObserver(): void {
    this.observer = new MutationObserver(() => {
      // Reset idle count when DOM changes (new content loaded)
      if (this.idleCount > 0) {
        this.idleCount = 0;
        logger.debug("DOM mutation detected, resetting idle count");
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  private async scrollLoop(): Promise<void> {
    while (!this.shouldStop) {
      if (this.isPaused) {
        await this.sleep(500);
        continue;
      }

      const currentHeight = document.documentElement.scrollHeight;
      const currentPos = window.scrollY;

      // Scroll down
      window.scrollBy(0, this.config.scrollStepPixels);
      this.totalScrolled += this.config.scrollStepPixels;

      // Wait for content to load
      await this.sleep(this.config.speed);

      // Check if we've reached the bottom
      const newHeight = document.documentElement.scrollHeight;
      const atBottom =
        currentPos + window.innerHeight >= currentHeight - 100;

      if (atBottom && newHeight === currentHeight) {
        this.idleCount++;
        logger.debug(`Near bottom, idle count: ${this.idleCount}/${this.config.maxIdleIterations}`);

        if (this.idleCount >= this.config.maxIdleIterations) {
          logger.info("AutoScroller: reached end of page (no new content)");
          break;
        }

        // Try clicking "Load More" or similar buttons
        await this.tryClickLoadMore();
        await this.sleep(2000);

        // Re-check height after load more attempt
        const retryHeight = document.documentElement.scrollHeight;
        if (retryHeight === newHeight) {
          this.idleCount++;
        } else {
          this.idleCount = 0;
        }
      } else if (newHeight > currentHeight) {
        this.idleCount = 0;
        this.lastHeight = newHeight;
      }

      // Report progress
      this.onProgress?.({
        scrollHeight: document.documentElement.scrollHeight,
        scrollPosition: window.scrollY,
        idleCount: this.idleCount,
        mediaCount: this.countMediaElements(),
      });
    }

    this.isRunning = false;
    this.cleanup();
  }

  /**
   * Try clicking Facebook's "See More", "Load More", or pagination buttons.
   */
  private async tryClickLoadMore(): Promise<void> {
    const selectors = [
      // Facebook "See more" / "Load more" patterns
      '[role="button"][aria-label*="See more"]',
      '[role="button"][aria-label*="Load more"]',
      '[role="button"][aria-label*="Show more"]',
      'a[href*="see_more"]',
      // Generic patterns
      ".see-more",
      ".load-more",
      // "View more" in comments/sections
      '[role="button"]:not([aria-label*="Comment"]):not([aria-label*="Like"]):not([aria-label*="React"])',
    ];

    for (const selector of selectors) {
      try {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (
            text.includes("see more") ||
            text.includes("load more") ||
            text.includes("show more") ||
            text.includes("view more")
          ) {
            logger.debug(`Clicking load-more button: "${text.trim()}"`);
            (btn as HTMLElement).click();
            await this.sleep(2000);
          }
        }
      } catch {
        // Ignore selector errors
      }
    }
  }

  private countMediaElements(): number {
    return (
      document.querySelectorAll(
        'img[src*="fbcdn"], img[src*="facebook"], video[src*="fbcdn"], video source[src*="fbcdn"]'
      ).length
    );
  }

  private cleanup(): void {
    if (this.scrollTimer) {
      clearTimeout(this.scrollTimer);
      this.scrollTimer = null;
    }
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
