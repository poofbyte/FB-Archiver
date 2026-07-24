import type { SessionState } from "../types";
import { db } from "../storage/indexeddb";
import { logger } from "../utils/logger";

/**
 * Manages session persistence for resume-after-crash support.
 * Saves and restores scroll position, download queue state, and progress.
 */
export class ResumeManager {
  private sessionUrl: string = "";

  /**
   * Initialize with the current page URL.
   */
  async init(url: string): Promise<SessionState | null> {
    this.sessionUrl = url;

    // Try to restore previous session for this URL
    const existing = await db.getSession(url);
    if (existing) {
      logger.info("ResumeManager: found existing session", {
        url,
        lastPosition: existing.scrollPosition,
        totalFound: existing.totalFound,
      });
    }

    return existing ?? null;
  }

  /**
   * Save the current session state.
   */
  async save(state: Partial<SessionState>): Promise<void> {
    const full: SessionState = {
      lastPosition: state.lastPosition ?? window.scrollY,
      totalFound: state.totalFound ?? 0,
      totalDownloaded: state.totalDownloaded ?? 0,
      isRunning: state.isRunning ?? false,
      isPaused: state.isPaused ?? false,
      currentUrl: this.sessionUrl,
      startedAt: state.startedAt ?? Date.now(),
      scrollPosition: state.scrollPosition ?? window.scrollY,
    };

    await db.saveSession(full);
  }

  /**
   * Check if there's a resumable session for the given URL.
   */
  async hasResumableSession(url: string): Promise<boolean> {
    const session = await db.getSession(url);
    return session !== undefined && session.isRunning;
  }

  /**
   * Get the last saved scroll position.
   */
  async getScrollPosition(url: string): Promise<number> {
    const session = await db.getSession(url);
    return session?.scrollPosition ?? 0;
  }

  /**
   * Restore scroll position.
   */
  async restoreScrollPosition(url: string): Promise<boolean> {
    const pos = await this.getScrollPosition(url);
    if (pos > 0) {
      window.scrollTo(0, pos);
      logger.info(`ResumeManager: restored scroll position to ${pos}`);
      return true;
    }
    return false;
  }

  /**
   * Get the last session for auto-resume.
   */
  async getLastSession(): Promise<SessionState | null> {
    return (await db.getLastSession()) ?? null;
  }

  /**
   * Mark session as complete.
   */
  async markComplete(): Promise<void> {
    await this.save({
      isRunning: false,
      isPaused: false,
    });
    logger.info("ResumeManager: session marked complete");
  }

  /**
   * Clear session data.
   */
  async clearSession(): Promise<void> {
    await this.save({
      lastPosition: 0,
      totalFound: 0,
      totalDownloaded: 0,
      isRunning: false,
      isPaused: false,
    });
  }
}
