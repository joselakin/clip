import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const fixedNow = 1_717_171_717_171;

const {
  validateURLMock,
  getInfoMock,
  downloadFromInfoMock,
  createWriteStreamMock,
  pipelineMock,
  mkdirMock,
  unlinkMock,
  buildYoutubeRequestOptionsMock,
  getYoutubeDownloaderModeMock,
  downloadYoutubeVideoWithYtDlpMock,
  classifyYoutubeDownloaderErrorMock,
  decideYoutubeFallbackPlanMock,
  toFriendlyYoutubeErrorMock,
  getStorageRootDirMock,
} = vi.hoisted(() => ({
  validateURLMock: vi.fn(),
  getInfoMock: vi.fn(),
  downloadFromInfoMock: vi.fn(),
  createWriteStreamMock: vi.fn(),
  pipelineMock: vi.fn(),
  mkdirMock: vi.fn(),
  unlinkMock: vi.fn(),
  buildYoutubeRequestOptionsMock: vi.fn(),
  getYoutubeDownloaderModeMock: vi.fn(),
  downloadYoutubeVideoWithYtDlpMock: vi.fn(),
  classifyYoutubeDownloaderErrorMock: vi.fn(),
  decideYoutubeFallbackPlanMock: vi.fn(),
  toFriendlyYoutubeErrorMock: vi.fn(),
  getStorageRootDirMock: vi.fn(),
}));

vi.mock("@distube/ytdl-core", () => ({
  default: {
    validateURL: validateURLMock,
    getInfo: getInfoMock,
    downloadFromInfo: downloadFromInfoMock,
  },
}));

vi.mock("node:fs", () => ({
  createWriteStream: createWriteStreamMock,
}));

vi.mock("node:stream/promises", () => ({
  pipeline: pipelineMock,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  unlink: unlinkMock,
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@/lib/storage", () => ({
  getStorageRootDir: getStorageRootDirMock,
}));

vi.mock("@/lib/youtube/helpers", () => ({
  buildYoutubeRequestOptions: buildYoutubeRequestOptionsMock,
  classifyYoutubeDownloaderError: classifyYoutubeDownloaderErrorMock,
  decideYoutubeFallbackPlan: decideYoutubeFallbackPlanMock,
  downloadYoutubeVideoWithYtDlp: downloadYoutubeVideoWithYtDlpMock,
  extractCodecs: () => ({ videoCodec: null, audioCodec: null }),
  getRetryDelayMs: () => 0,
  getYoutubeDownloaderMode: getYoutubeDownloaderModeMock,
  getYoutubeRetryConfig: () => ({ maxRetries: 0, baseDelayMs: 1 }),
  isBotCheckError: () => false,
  isForbiddenError: () => false,
  isRateLimitedError: () => false,
  pickBestCombinedFormat: (formats: Array<Record<string, unknown>>) => formats[0] ?? null,
  shouldEnableYtDlpFallback: () => true,
  toFriendlyYoutubeError: toFriendlyYoutubeErrorMock,
}));

import { downloadYoutubeVideoToLocal } from "@/lib/youtube";

describe("downloadYoutubeVideoToLocal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    validateURLMock.mockReturnValue(true);
    buildYoutubeRequestOptionsMock.mockResolvedValue({
      requestOptions: { headers: {} },
      playerClients: ["WEB"],
    });
    getStorageRootDirMock.mockReturnValue("/tmp/storage");
    getYoutubeDownloaderModeMock.mockReturnValue("ytdl-core-primary");
    decideYoutubeFallbackPlanMock.mockImplementation((mode: string, errorKind: string) => {
      if (mode === "ytdl-core-primary" && errorKind === "unknown") {
        return {
          primary: "ytdl-core",
          fallbackTo: null,
          shouldFallback: false,
          reason: "policy_disallows_fallback",
        };
      }

      return {
        primary: "ytdl-core",
        fallbackTo: null,
        shouldFallback: false,
        reason: "policy_disallows_fallback",
      };
    });
    classifyYoutubeDownloaderErrorMock.mockReturnValue("unknown");
    toFriendlyYoutubeErrorMock.mockImplementation((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
  });

  it("uses yt-dlp as the primary engine in yt-dlp-primary mode", async () => {
    const expected = { filePath: "/tmp/video.mp4" };

    getYoutubeDownloaderModeMock.mockReturnValue("yt-dlp-primary");
    decideYoutubeFallbackPlanMock.mockReturnValue({
      primary: "yt-dlp",
      fallbackTo: "ytdl-core",
      shouldFallback: true,
      reason: "prefer_yt_dlp",
    });
    downloadYoutubeVideoWithYtDlpMock.mockResolvedValue(expected);

    await expect(downloadYoutubeVideoToLocal("https://youtube.com/watch?v=abc123")).resolves.toEqual(expected);
    expect(downloadYoutubeVideoWithYtDlpMock).toHaveBeenCalledWith("https://youtube.com/watch?v=abc123");
    expect(getInfoMock).not.toHaveBeenCalled();
  });

  it("falls back from ytdl-core to yt-dlp when policy allows", async () => {
    const expected = { filePath: "/tmp/video.mp4" };

    getYoutubeDownloaderModeMock.mockReturnValue("ytdl-core-primary");
    decideYoutubeFallbackPlanMock
      .mockReturnValueOnce({
        primary: "ytdl-core",
        fallbackTo: null,
        shouldFallback: false,
        reason: "prefer_ytdl_core",
      })
      .mockReturnValueOnce({
        primary: "ytdl-core",
        fallbackTo: "yt-dlp",
        shouldFallback: true,
        reason: "fallback_on_bot_check",
      });
    classifyYoutubeDownloaderErrorMock.mockReturnValue("bot_check");
    getInfoMock.mockRejectedValue(new Error("Failed to find any playable formats"));
    downloadYoutubeVideoWithYtDlpMock.mockResolvedValue(expected);

    await expect(downloadYoutubeVideoToLocal("https://youtube.com/watch?v=abc123")).resolves.toEqual(expected);
    expect(downloadYoutubeVideoWithYtDlpMock).toHaveBeenCalledWith("https://youtube.com/watch?v=abc123");
  });

  it("surfaces friendly error when fallback is not allowed", async () => {
    const friendly = new Error("friendly failure");

    getYoutubeDownloaderModeMock.mockReturnValue("yt-dlp-primary");
    decideYoutubeFallbackPlanMock
      .mockReturnValueOnce({
        primary: "yt-dlp",
        fallbackTo: "ytdl-core",
        shouldFallback: true,
        reason: "prefer_yt_dlp",
      })
      .mockReturnValueOnce({
        primary: "yt-dlp",
        fallbackTo: null,
        shouldFallback: false,
        reason: "policy_disallows_fallback",
      });
    downloadYoutubeVideoWithYtDlpMock.mockRejectedValue(new Error("yt-dlp blocked"));
    classifyYoutubeDownloaderErrorMock.mockReturnValue("bot_check");
    toFriendlyYoutubeErrorMock.mockReturnValue(friendly);

    await expect(downloadYoutubeVideoToLocal("https://youtube.com/watch?v=abc123")).rejects.toThrow("friendly failure");
    expect(toFriendlyYoutubeErrorMock).toHaveBeenCalled();
  });

  it("deletes partial ytdl-core output when pipeline fails", async () => {
    const stream = new PassThrough();
    const writeStream = new PassThrough();
    const pipelineError = new Error("disk full");

    getInfoMock.mockResolvedValue({
      videoDetails: {
        videoId: "abc123",
        isLiveContent: false,
        lengthSeconds: "10",
        title: "Video",
        author: { name: "Channel" },
      },
      formats: [
        {
          hasAudio: true,
          hasVideo: true,
          container: "mp4",
          itag: 18,
          mimeType: "video/mp4",
          bitrate: 1000,
          fps: 30,
          width: 1280,
          height: 720,
          audioSampleRate: "44100",
          audioChannels: 2,
        },
      ],
    });
    downloadFromInfoMock.mockReturnValue(stream);
    createWriteStreamMock.mockReturnValue(writeStream);
    pipelineMock.mockRejectedValue(pipelineError);
    unlinkMock.mockResolvedValue(undefined);

    await expect(downloadYoutubeVideoToLocal("https://youtube.com/watch?v=abc123")).rejects.toThrow("disk full");
    expect(unlinkMock).toHaveBeenCalledWith(`/tmp/storage/youtube/abc123-${fixedNow}.mp4`);
  });
});
