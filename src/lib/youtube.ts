import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import ytdl from "@distube/ytdl-core";
import { createLogger } from "@/lib/logger";
import { getStorageRootDir } from "@/lib/storage";

const logger = createLogger("lib/youtube");
const execFileAsync = promisify(execFile);

type YtdlCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

type YtdlRequestOptions = {
  requestOptions?: {
    headers?: Record<string, string>;
  };
  playerClients?: Array<"WEB" | "WEB_EMBEDDED" | "TV" | "IOS" | "ANDROID">;
  agent?: unknown;
};

type WrappedCookieExport = {
  data?: string;
  url?: string;
  version?: number;
};

type YtDlpVideoInfo = {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  fps?: number;
  width?: number;
  height?: number;
  ext?: string;
  tbr?: number;
  asr?: number;
  audio_channels?: number;
  vcodec?: string;
  acodec?: string;
};

function extractCodecs(mimeType?: string | null): { videoCodec: string | null; audioCodec: string | null } {
  if (!mimeType) {
    return { videoCodec: null, audioCodec: null };
  }

  const match = mimeType.match(/codecs="([^"]+)"/);
  if (!match) {
    return { videoCodec: null, audioCodec: null };
  }

  const codecs = match[1].split(",").map((item) => item.trim());
  const videoCodec = codecs.find((item) => /^avc1|^vp9|^h264|^hev1|^hvc1|^av01/i.test(item)) || null;
  const audioCodec = codecs.find((item) => /^mp4a|^opus|^aac|^vorbis/i.test(item)) || null;

  return { videoCodec, audioCodec };
}

function pickBestCombinedFormat(formats: Array<Record<string, unknown>>) {
  const combined = formats.filter((format) => {
    return Boolean(format.hasAudio) && Boolean(format.hasVideo);
  });

  if (combined.length === 0) {
    return null;
  }

  combined.sort((a, b) => {
    const aHeight = typeof a.height === "number" ? a.height : 0;
    const bHeight = typeof b.height === "number" ? b.height : 0;
    if (bHeight !== aHeight) {
      return bHeight - aHeight;
    }

    const aBitrate = typeof a.bitrate === "number" ? a.bitrate : 0;
    const bBitrate = typeof b.bitrate === "number" ? b.bitrate : 0;
    return bBitrate - aBitrate;
  });

  return combined[0] as {
    itag: number;
    container?: string;
    mimeType?: string;
    fps?: number;
    width?: number;
    height?: number;
    bitrate?: number;
    audioSampleRate?: string;
    audioChannels?: number;
  };
}

function isRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  return lower.includes("429") || lower.includes("too many requests") || lower.includes("rate limit");
}

function isBotCheckError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  return lower.includes("sign in to confirm") || lower.includes("not a bot");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getYoutubeRetryConfig() {
  return {
    maxRetries: parsePositiveInt(process.env.YOUTUBE_GETINFO_MAX_RETRIES, 2),
    baseDelayMs: parsePositiveInt(process.env.YOUTUBE_RETRY_BASE_MS, 1200),
  };
}

function getRetryDelayMs(baseDelayMs: number, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(10_000, baseDelayMs * 2 ** exponent);
}

function getPlayerClientsForAttempt(attempt: number): Array<"WEB" | "WEB_EMBEDDED" | "TV" | "IOS" | "ANDROID"> {
  const variants: Array<Array<"WEB" | "WEB_EMBEDDED" | "TV" | "IOS" | "ANDROID">> = [
    ["WEB_EMBEDDED", "IOS", "ANDROID", "TV"],
    ["ANDROID", "IOS", "TV", "WEB"],
    ["TV", "IOS", "ANDROID", "WEB_EMBEDDED"],
  ];

  return variants[Math.min(attempt, variants.length - 1)];
}

function shouldEnableYtDlpFallback(): boolean {
  const value = (process.env.YOUTUBE_ENABLE_YTDLP_FALLBACK || "true").trim().toLowerCase();
  return value !== "0" && value !== "false" && value !== "off";
}

function getYtDlpBin(): string {
  return process.env.YTDLP_BIN?.trim() || "yt-dlp";
}

function getYoutubeExternalDownloaderProxyArgs(): string[] {
  const proxy = process.env.YOUTUBE_PROXY_URL?.trim();
  if (!proxy) {
    return [];
  }
  return ["--proxy", proxy];
}

function sanitizeCookieValue(value: string): string {
  return value.replace(/[\t\r\n]/g, "");
}

function toCookieEpochSeconds(expirationDate?: number): number {
  if (typeof expirationDate === "number" && Number.isFinite(expirationDate) && expirationDate > 0) {
    return Math.floor(expirationDate);
  }
  return 0;
}

function toNetscapeCookieLine(cookie: YtdlCookie): string {
  const domain = cookie.domain?.trim() || ".youtube.com";
  const normalizedDomain = domain.startsWith(".") ? domain : `.${domain}`;
  const includeSubdomains = normalizedDomain.startsWith(".") ? "TRUE" : "FALSE";
  const pathValue = cookie.path?.trim() || "/";
  const secure = cookie.secure ? "TRUE" : "FALSE";
  const expires = String(toCookieEpochSeconds(cookie.expirationDate));
  const name = sanitizeCookieValue(cookie.name);
  const value = sanitizeCookieValue(cookie.value);
  return [normalizedDomain, includeSubdomains, pathValue, secure, expires, name, value].join("\t");
}

async function buildYtDlpCookieFilePath(): Promise<string | null> {
  const cookies = await resolveYoutubeCookiesFromEnv();
  if (!cookies || cookies.length === 0) {
    return null;
  }

  const tmpDir = path.join(getStorageRootDir(), "tmp");
  await mkdir(tmpDir, { recursive: true });

  const cookieFilePath = path.join(
    tmpDir,
    `yt-dlp-cookies-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );

  const lines = [
    "# Netscape HTTP Cookie File",
    ...cookies
      .filter((cookie) => cookie.name.trim().length > 0 && cookie.value.trim().length > 0)
      .map((cookie) => toNetscapeCookieLine(cookie)),
    "",
  ];

  await writeFile(cookieFilePath, lines.join("\n"), "utf8");
  logger.info("ytdlp_cookie_file_created", { cookieFilePath, cookieCount: cookies.length });
  return cookieFilePath;
}

async function hashFileSha256(filePath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;

  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.length;
  }

  return {
    sha256: hash.digest("hex"),
    sizeBytes,
  };
}

async function downloadYoutubeVideoWithYtDlp(url: string) {
  const root = getStorageRootDir();
  const createdAt = Date.now();
  const outputTemplate = path.join(root, "youtube", `%(id)s-${createdAt}.%(ext)s`);
  await mkdir(path.dirname(outputTemplate), { recursive: true });

  const cookieFilePath = await buildYtDlpCookieFilePath();
  const commonArgs = [
    "--no-playlist",
    "--js-runtimes",
    process.env.YTDLP_JS_RUNTIME?.trim() || "node",
    ...getYoutubeExternalDownloaderProxyArgs(),
    ...(cookieFilePath ? ["--cookies", cookieFilePath] : []),
    "--extractor-args",
    "youtube:player_client=android,ios,tv,web",
  ];

  try {
    const infoArgs = [...commonArgs, "--dump-single-json", url];
    logger.info("ytdlp_info_started", { bin: getYtDlpBin(), args: infoArgs });

    let parsedInfo: YtDlpVideoInfo;
    try {
      const { stdout } = await execFileAsync(getYtDlpBin(), infoArgs, { maxBuffer: 10 * 1024 * 1024 });
      parsedInfo = JSON.parse(stdout.trim()) as YtDlpVideoInfo;
    } catch (error) {
      logger.error("ytdlp_info_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error(
        "Fallback yt-dlp gagal mengambil info video. Pastikan yt-dlp terpasang, cookie valid, atau set YTDLP_BIN yang benar."
      );
    }

    const downloadArgs = [
      ...commonArgs,
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "-o",
      outputTemplate,
      url,
    ];

    logger.info("ytdlp_download_started", { bin: getYtDlpBin(), outputTemplate });

    try {
      await execFileAsync(getYtDlpBin(), downloadArgs, { maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      logger.error("ytdlp_download_failed", {
        message: error instanceof Error ? error.message : "Unknown error",
      });
      throw new Error("Fallback yt-dlp gagal mengunduh video.");
    }

    const videoId = parsedInfo.id?.trim() || "unknown";
    const preferredExt = "mp4";
    const outputFileName = `${videoId}-${createdAt}.${preferredExt}`;
    const outputPath = path.join(root, "youtube", outputFileName);
    const storageKey = `youtube/${outputFileName}`;

    const { sha256, sizeBytes } = await hashFileSha256(outputPath);

    logger.info("ytdlp_download_completed", {
      outputPath,
      storageKey,
      sizeBytes,
    });

    return {
      outputPath,
      storageKey,
      sha256,
      downloadedBytes: sizeBytes,
      durationMs: Math.max(1, Math.floor((parsedInfo.duration || 0) * 1000)),
      videoId,
      title: parsedInfo.title || videoId,
      channelName: parsedInfo.channel || parsedInfo.uploader || null,
      fps: typeof parsedInfo.fps === "number" ? parsedInfo.fps : null,
      width: typeof parsedInfo.width === "number" ? parsedInfo.width : null,
      height: typeof parsedInfo.height === "number" ? parsedInfo.height : null,
      mimeType: parsedInfo.ext ? `video/${parsedInfo.ext}` : null,
      bitrateKbps: typeof parsedInfo.tbr === "number" ? Math.round(parsedInfo.tbr) : null,
      sampleRate: typeof parsedInfo.asr === "number" ? Math.round(parsedInfo.asr) : null,
      channels: typeof parsedInfo.audio_channels === "number" ? parsedInfo.audio_channels : null,
      videoCodec: parsedInfo.vcodec || null,
      audioCodec: parsedInfo.acodec || null,
    };
  } finally {
    if (cookieFilePath) {
      await unlink(cookieFilePath).catch(() => undefined);
      logger.info("ytdlp_cookie_file_removed", { cookieFilePath });
    }
  }
}

function validateCookiesArray(parsed: unknown, sourceName: string): YtdlCookie[] {
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceName} harus berupa JSON array cookie`);
  }

  const cookies = parsed.filter((item): item is YtdlCookie => {
    if (!item || typeof item !== "object") {
      return false;
    }

    const record = item as Record<string, unknown>;
    return typeof record.name === "string" && typeof record.value === "string";
  });

  if (cookies.length === 0) {
    throw new Error(`${sourceName} tidak berisi cookie yang valid`);
  }

  return cookies;
}

function parseCookiesArrayJson(raw: string, sourceName: string): YtdlCookie[] {
  const parsed = JSON.parse(raw) as unknown;
  return validateCookiesArray(parsed, sourceName);
}

function parseWrappedCookieExport(raw: string, sourceName: string): YtdlCookie[] {
  const parsed = JSON.parse(raw) as WrappedCookieExport;
  if (!parsed || typeof parsed !== "object" || typeof parsed.data !== "string") {
    throw new Error(`${sourceName} bukan format cookie export yang dikenali`);
  }

  const decoded = Buffer.from(parsed.data, "base64").toString("utf8").trim();
  if (!decoded) {
    throw new Error(`${sourceName} tidak bisa didecode`);
  }

  try {
    return validateCookiesArray(JSON.parse(decoded), sourceName);
  } catch {
    throw new Error(
      `${sourceName} terdeteksi format export terenkripsi/tidak kompatibel. Export ulang cookies YouTube sebagai JSON array biasa.`
    );
  }
}

function parseCookiesFromUnknownJson(raw: string, sourceName: string): YtdlCookie[] {
  try {
    return parseCookiesArrayJson(raw, sourceName);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Parse gagal";
    if (!message.includes("JSON array")) {
      throw error;
    }
  }

  return parseWrappedCookieExport(raw, sourceName);
}

async function resolveYoutubeCookiesFromEnv(): Promise<YtdlCookie[] | null> {
  const rawJson = process.env.YOUTUBE_COOKIES_JSON?.trim();
  const rawB64 = process.env.YOUTUBE_COOKIES_BASE64?.trim();
  const rawFilePath = process.env.YOUTUBE_COOKIES_FILE?.trim();

  if (!rawJson && !rawB64 && !rawFilePath) {
    return null;
  }

  try {
    if (rawFilePath) {
      const resolvedPath = path.isAbsolute(rawFilePath)
        ? rawFilePath
        : path.join(process.cwd(), rawFilePath);
      const content = await readFile(resolvedPath, "utf8");
      const cookies = parseCookiesFromUnknownJson(content, "YOUTUBE_COOKIES_FILE");
      logger.info("youtube_cookies_loaded_from_file", {
        filePath: rawFilePath,
        cookieCount: cookies.length,
      });
      return cookies;
    }

    if (rawJson) {
      return parseCookiesFromUnknownJson(rawJson, "YOUTUBE_COOKIES_JSON");
    }

    const decoded = Buffer.from(rawB64 || "", "base64").toString("utf8");
    return parseCookiesFromUnknownJson(decoded, "YOUTUBE_COOKIES_BASE64");
  } catch (error) {
    logger.error("invalid_youtube_cookies_env", {
      message: error instanceof Error ? error.message : "Invalid cookies",
    });
    throw new Error(
      "Konfigurasi cookies YouTube tidak valid. Cek YOUTUBE_COOKIES_FILE/YOUTUBE_COOKIES_JSON/YOUTUBE_COOKIES_BASE64."
    );
  }
}

async function buildYoutubeRequestOptions(opts?: {
  includeCookies?: boolean;
  playerAttempt?: number;
}): Promise<YtdlRequestOptions> {
  const userAgent =
    process.env.YOUTUBE_USER_AGENT?.trim() ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const includeCookies = opts?.includeCookies ?? false;
  const playerAttempt = opts?.playerAttempt ?? 0;

  const options: YtdlRequestOptions = {
    requestOptions: {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    playerClients: getPlayerClientsForAttempt(playerAttempt),
  };

  const proxyUrl = process.env.YOUTUBE_PROXY_URL?.trim();
  const cookies = includeCookies ? await resolveYoutubeCookiesFromEnv() : null;
  if (proxyUrl) {
    options.agent = cookies && cookies.length > 0
      ? ytdl.createProxyAgent(proxyUrl, cookies)
      : ytdl.createProxyAgent(proxyUrl);
    logger.info("youtube_proxy_agent_enabled", {
      proxyEnabled: true,
      includeCookies,
      cookieCount: cookies?.length || 0,
    });
  } else if (cookies && cookies.length > 0) {
    options.agent = ytdl.createAgent(cookies);
    logger.info("youtube_cookie_agent_enabled", { cookieCount: cookies.length });
  }

  return options;
}

function toFriendlyYoutubeError(error: unknown): Error {
  const rawMessage = error instanceof Error ? error.message : "Gagal mengambil data video YouTube";
  const lower = rawMessage.toLowerCase();

  if (lower.includes("sign in to confirm you’re not a bot") || lower.includes("sign in to confirm you're not a bot")) {
    return new Error(
      "YouTube memblokir request (bot check). Sistem sudah mencoba mode no-cookie terlebih dulu. Jika masih gagal, gunakan YOUTUBE_COOKIES_* atau YOUTUBE_PROXY_URL lalu restart server."
    );
  }

  if (lower.includes("429")) {
    return new Error(
      "YouTube rate limit (429). Coba lagi beberapa saat atau gunakan YOUTUBE_COOKIES_JSON/proxy."
    );
  }

  return new Error(rawMessage);
}

export async function downloadYoutubeVideoToLocal(url: string) {
  const trimmedUrl = url.trim();

  logger.info("download_request_started", { url: trimmedUrl });

  if (!ytdl.validateURL(trimmedUrl)) {
    logger.warn("invalid_youtube_url", { url: trimmedUrl });
    throw new Error("URL YouTube tidak valid");
  }

  const baseOptions = await buildYoutubeRequestOptions({ includeCookies: false, playerAttempt: 0 });
  const hasCookieConfig = Boolean(
    process.env.YOUTUBE_COOKIES_FILE?.trim() ||
      process.env.YOUTUBE_COOKIES_JSON?.trim() ||
      process.env.YOUTUBE_COOKIES_BASE64?.trim()
  );
  const retryConfig = getYoutubeRetryConfig();

  let info: Awaited<ReturnType<typeof ytdl.getInfo>>;
  let infoOptionsForDownload: YtdlRequestOptions = baseOptions;
  let lastError: unknown;

  const modes: Array<{ label: "no_cookie" | "with_cookie"; includeCookies: boolean }> = [
    { label: "no_cookie", includeCookies: false },
    ...(hasCookieConfig ? [{ label: "with_cookie" as const, includeCookies: true }] : []),
  ];

  outer: for (const mode of modes) {
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt += 1) {
      try {
        const optionsForAttempt = await buildYoutubeRequestOptions({
          includeCookies: mode.includeCookies,
          playerAttempt: attempt,
        });

        if (attempt > 0 || mode.includeCookies) {
          logger.warn("youtube_get_info_retry_attempt", {
            mode: mode.label,
            attempt,
            playerClients: optionsForAttempt.playerClients,
          });
        }

        info = await ytdl.getInfo(trimmedUrl, optionsForAttempt);
        infoOptionsForDownload = optionsForAttempt;
        logger.info("youtube_get_info_success", { mode: mode.label, attempt });
        break outer;
      } catch (error) {
        lastError = error;
        logger.error("youtube_get_info_failed", {
          mode: mode.label,
          attempt,
          message: error instanceof Error ? error.message : "Unknown error",
        });

        const canRetry = isRateLimitedError(error) && attempt < retryConfig.maxRetries;
        if (canRetry) {
          const waitMs = getRetryDelayMs(retryConfig.baseDelayMs, attempt + 1);
          logger.warn("youtube_get_info_retry_wait", { mode: mode.label, waitMs });
          await delay(waitMs);
          continue;
        }

        const shouldTryNextMode = mode.label === "no_cookie" && hasCookieConfig;
        if (shouldTryNextMode && (isBotCheckError(error) || isRateLimitedError(error))) {
          logger.warn("youtube_get_info_switching_mode", {
            from: mode.label,
            to: "with_cookie",
            reason: error instanceof Error ? error.message : "Unknown error",
          });
        }

        break;
      }
    }
  }

  if (!info) {
    if (lastError && shouldEnableYtDlpFallback() && (isRateLimitedError(lastError) || isBotCheckError(lastError))) {
      logger.warn("youtube_fallback_to_ytdlp", {
        reason: lastError instanceof Error ? lastError.message : "Unknown error",
      });
      return downloadYoutubeVideoWithYtDlp(trimmedUrl);
    }

    throw toFriendlyYoutubeError(lastError || new Error("Gagal mengambil info video YouTube"));
  }

  logger.info("youtube_info_resolved", { videoId: info.videoDetails.videoId });

  if (info.videoDetails.isLiveContent) {
    logger.warn("live_stream_not_supported", { videoId: info.videoDetails.videoId });
    throw new Error("Live stream belum didukung untuk proses ini");
  }

  const format = pickBestCombinedFormat(info.formats as Array<Record<string, unknown>>);
  if (!format) {
    logger.error("missing_combined_format", { videoId: info.videoDetails.videoId });
    throw new Error("Format audio+video gabungan tidak ditemukan");
  }

  const extension = format.container || "mp4";
  const videoId = info.videoDetails.videoId;
  const storageKey = `youtube/${videoId}-${Date.now()}.${extension}`;

  const root = getStorageRootDir();
  const outputPath = path.join(root, storageKey);

  await mkdir(path.dirname(outputPath), { recursive: true });
  logger.info("download_stream_started", { outputPath, itag: format.itag });

  const hash = createHash("sha256");
  let downloadedBytes = 0;

  const stream = ytdl.downloadFromInfo(info, {
    quality: format.itag,
    filter: "audioandvideo",
    ...infoOptionsForDownload,
  });
  stream.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    downloadedBytes += chunk.length;
  });

  try {
    await pipeline(stream, createWriteStream(outputPath));
  } catch (error) {
    logger.error("youtube_download_stream_failed", {
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw toFriendlyYoutubeError(error);
  }
  logger.info("download_stream_completed", { outputPath, downloadedBytes });

  const sha256 = hash.digest("hex");
  const durationSec = Number(info.videoDetails.lengthSeconds || "0");
  const durationMs = Math.max(1, Math.floor(durationSec * 1000));
  const bitrateKbps = typeof format.bitrate === "number" ? Math.round(format.bitrate / 1000) : null;

  const { videoCodec, audioCodec } = extractCodecs(format.mimeType || null);

  return {
    outputPath,
    storageKey,
    sha256,
    downloadedBytes,
    durationMs,
    videoId,
    title: info.videoDetails.title,
    channelName: info.videoDetails.author?.name || null,
    fps: typeof format.fps === "number" ? format.fps : null,
    width: typeof format.width === "number" ? format.width : null,
    height: typeof format.height === "number" ? format.height : null,
    mimeType: format.mimeType || null,
    bitrateKbps,
    sampleRate: format.audioSampleRate ? Number(format.audioSampleRate) : null,
    channels: typeof format.audioChannels === "number" ? format.audioChannels : null,
    videoCodec,
    audioCodec,
  };
}

export async function removeDownloadedFile(filePath: string) {
  logger.info("remove_downloaded_file", { filePath });
  await unlink(filePath).catch(() => undefined);
}
