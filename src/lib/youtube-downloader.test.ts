import { describe, expect, it } from "vitest";

import {
  classifyYoutubeDownloaderError,
  decideYoutubeFallbackPlan,
  getYoutubeDownloaderMode,
  toFriendlyYoutubeError,
  getYoutubeImportErrorStatus,
} from "@/lib/youtube/helpers";

describe("getYoutubeDownloaderMode", () => {
  it("defaults to yt-dlp-primary", () => {
    expect(getYoutubeDownloaderMode(undefined)).toBe("yt-dlp-primary");
  });

  it("accepts hybrid and ytdl-core-primary", () => {
    expect(getYoutubeDownloaderMode("hybrid")).toBe("hybrid");
    expect(getYoutubeDownloaderMode("ytdl-core-primary")).toBe("ytdl-core-primary");
  });

  it("normalizes trimmed and case-insensitive mode values", () => {
    expect(getYoutubeDownloaderMode("  HYBRID  ")).toBe("hybrid");
    expect(getYoutubeDownloaderMode("  YTDL-CORE-PRIMARY  ")).toBe("ytdl-core-primary");
  });

  it("falls back to yt-dlp-primary for invalid mode values", () => {
    expect(getYoutubeDownloaderMode("something-else")).toBe("yt-dlp-primary");
  });
});

describe("decideYoutubeFallbackPlan", () => {
  it("defaults yt-dlp-primary to yt-dlp first and never falls back on generic errors", () => {
    expect(decideYoutubeFallbackPlan("yt-dlp-primary", "unknown")).toEqual({
      primary: "yt-dlp",
      fallbackTo: null,
      shouldFallback: false,
      reason: "policy_disallows_fallback",
    });
  });

  it("allows yt-dlp-primary to fall back to ytdl-core only for missing binary", () => {
    expect(decideYoutubeFallbackPlan("yt-dlp-primary", "binary_missing")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "binary_missing",
    });
  });

  it("allows yt-dlp-primary to fall back to ytdl-core for missing js runtime", () => {
    expect(decideYoutubeFallbackPlan("yt-dlp-primary", "js_runtime_missing")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "js_runtime_missing",
    });
  });

  it("keeps hybrid mode on yt-dlp first with adaptive cross-engine fallback", () => {
    expect(decideYoutubeFallbackPlan("hybrid", "binary_missing")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "binary_missing",
    });
    expect(decideYoutubeFallbackPlan("hybrid", "js_runtime_missing")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "js_runtime_missing",
    });
    expect(decideYoutubeFallbackPlan("hybrid", "forbidden")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "forbidden",
    });
    expect(decideYoutubeFallbackPlan("hybrid", "bot_check")).toEqual({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "bot_check",
    });
    expect(decideYoutubeFallbackPlan("hybrid", "unknown")).toEqual({
      primary: "yt-dlp",
      fallbackTo: null,
      shouldFallback: false,
      reason: "policy_disallows_fallback",
    });
  });

  it("preserves ytdl-core-primary mode with yt-dlp fallback for YouTube blocking errors", () => {
    expect(decideYoutubeFallbackPlan("ytdl-core-primary", "bot_check")).toEqual({
      primary: "ytdl-core",
      fallbackTo: "yt-dlp",
      shouldFallback: true,
      reason: "bot_check",
    });
    expect(decideYoutubeFallbackPlan("ytdl-core-primary", "rate_limit")).toEqual({
      primary: "ytdl-core",
      fallbackTo: "yt-dlp",
      shouldFallback: true,
      reason: "rate_limit",
    });
  });
});

describe("classifyYoutubeDownloaderError", () => {
  it("classifies bot check", () => {
    expect(classifyYoutubeDownloaderError(new Error("Sign in to confirm you’re not a bot"))).toBe("bot_check");
  });

  it("classifies no playable formats", () => {
    expect(classifyYoutubeDownloaderError(new Error("Failed to find any playable formats"))).toBe("no_playable_formats");
    expect(classifyYoutubeDownloaderError(new Error("Format audio+video gabungan tidak ditemukan"))).toBe("no_playable_formats");
  });

  it("classifies rate limit", () => {
    expect(classifyYoutubeDownloaderError(new Error("429 Too Many Requests"))).toBe("rate_limit");
  });

  it("classifies forbidden", () => {
    expect(classifyYoutubeDownloaderError(new Error("403 Forbidden"))).toBe("forbidden");
  });

  it("classifies invalid or stale cookies", () => {
    expect(classifyYoutubeDownloaderError(new Error("Cookie expired and stale for youtube.com"))).toBe(
      "cookie_invalid_or_stale",
    );
  });

  it("classifies binary missing for explicit yt-dlp spawn signatures", () => {
    expect(classifyYoutubeDownloaderError(new Error("spawn yt-dlp ENOENT"))).toBe("binary_missing");
  });

  it("classifies missing js runtime from explicit runtime phrases", () => {
    expect(classifyYoutubeDownloaderError(new Error("JavaScript runtime is required; use --js-runtimes"))).toBe(
      "js_runtime_missing",
    );
  });

  it("classifies proxy errors", () => {
    expect(classifyYoutubeDownloaderError(new Error("Proxy connection failed"))).toBe("proxy_error");
  });

  it("returns unknown when no classifier matches", () => {
    expect(classifyYoutubeDownloaderError(new Error("unexpected downloader issue"))).toBe("unknown");
  });

  it("does not treat generic not found as binary missing", () => {
    expect(classifyYoutubeDownloaderError(new Error("video not found"))).toBe("unknown");
  });

  it("does not treat ejs:github text as js runtime missing", () => {
    expect(classifyYoutubeDownloaderError(new Error("extractor reference ejs:github updated"))).toBe("unknown");
  });
});

describe("toFriendlyYoutubeError", () => {
  it("returns actionable guidance for stale cookies", () => {
    expect(toFriendlyYoutubeError(new Error("Cookie expired and stale for youtube.com")).message).toContain(
      "Cookies YouTube tidak valid atau sudah stale/expired",
    );
    expect(toFriendlyYoutubeError(new Error("Cookie expired and stale for youtube.com")).message).toContain(
      "YOUTUBE_COOKIES_FILE/YOUTUBE_COOKIES_JSON/YOUTUBE_COOKIES_BASE64",
    );
  });

  it("returns actionable guidance when yt-dlp binary is missing", () => {
    expect(toFriendlyYoutubeError(new Error("spawn yt-dlp ENOENT")).message).toBe(
      "Binary yt-dlp tidak ditemukan di server. Install yt-dlp atau tambahkan ke PATH, lalu coba lagi.",
    );
  });
});

describe("getYoutubeImportErrorStatus", () => {
  it("maps actionable downloader error kinds to 400", () => {
    expect(getYoutubeImportErrorStatus(new Error("Cookie expired and stale for youtube.com"))).toBe(400);
    expect(getYoutubeImportErrorStatus(new Error("spawn yt-dlp ENOENT"))).toBe(500);
    expect(getYoutubeImportErrorStatus(new Error("JavaScript runtime is required; use --js-runtimes"))).toBe(500);
    expect(getYoutubeImportErrorStatus(new Error("403 Forbidden"))).toBe(400);
    expect(getYoutubeImportErrorStatus(new Error("Failed to find any playable formats"))).toBe(400);
  });

  it("maps rate limit to 429 and unknown errors to 500", () => {
    expect(getYoutubeImportErrorStatus(new Error("429 Too Many Requests"))).toBe(429);
    expect(getYoutubeImportErrorStatus(new Error("unexpected downloader issue"))).toBe(500);
  });
});
