import type { LogLevel, LogEntry } from "../types";

class Logger {
  private static instance: Logger;
  private logs: LogEntry[] = [];
  private maxLogs = 1000;
  private minLevel: LogLevel = "INFO";

  private levelPriority: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  private constructor() {}

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return this.levelPriority[level] >= this.levelPriority[this.minLevel];
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: Date.now(),
      data,
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }

    const prefix = `[FB-Archiver][${level}]`;
    const time = new Date(entry.timestamp).toISOString();

    switch (level) {
      case "ERROR":
        console.error(`${prefix} ${time}: ${message}`, data ?? "");
        break;
      case "WARN":
        console.warn(`${prefix} ${time}: ${message}`, data ?? "");
        break;
      case "DEBUG":
        console.debug(`${prefix} ${time}: ${message}`, data ?? "");
        break;
      default:
        console.log(`${prefix} ${time}: ${message}`, data ?? "");
    }
  }

  info(message: string, data?: unknown): void {
    this.log("INFO", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log("WARN", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log("ERROR", message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log("DEBUG", message, data);
  }

  getLogs(level?: LogLevel): LogEntry[] {
    if (level) {
      return this.logs.filter((l) => l.level === level);
    }
    return [...this.logs];
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export const logger = Logger.getInstance();
