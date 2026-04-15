import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import ytdl from "@distube/ytdl-core";

import { createLogger } from "@/lib/logger";
import { getStorageRootDir } from "@/lib/storage";

const logger = createLogger("lib/youtube");
const execFileAsync = promisify(execFile);
const YTDLP_NIGHTLY_URL =
  "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp";

type YtdlCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
};

export type YtdlRequestOptions = Pick<ytdl.getInfoOptions, "requestOptions" | "playerClients" | "agent">;

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

export function extractCodecs(mimeType?: string | null): {
  videoCodec: string | null;
  audioCodec: string | null;
} {
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

export function pickBestCombinedFormat(formats: ytdl.videoFormat[]) {
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

  return combined[0];
}

export function isRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  return lower.includes("429") || lower.includes("too many requests") || lower.includes("rate limit");
}

export function isBotCheckError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  return lower.includes("sign in to confirm") || lower.includes("not a bot");
}

export function isForbiddenError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  return lower.includes("403") || lower.includes("forbidden");
}

export function parseBooleanFlag(value: string | undefined | null, defaultValue = false): boolean {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getYoutubeRetryConfig() {
  return {
    maxRetries: parsePositiveInt(process.env.YOUTUBE_GETINFO_MAX_RETRIES, 2),
    baseDelayMs: parsePositiveInt(process.env.YOUTUBE_RETRY_BASE_MS, 1200),
  };
}

export function getRetryDelayMs(baseDelayMs: number, attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(10_000, baseDelayMs * 2 ** exponent);
}

export function getYtDlpRetryConfig() {
  return {
    infoMaxRetries: parsePositiveInt(process.env.YTDLP_INFO_MAX_RETRIES, 2),
    downloadMaxRetries: parsePositiveInt(process.env.YTDLP_DOWNLOAD_MAX_RETRIES, 2),
    baseDelayMs: parsePositiveInt(process.env.YTDLP_RETRY_BASE_MS, 1200),
  };
}

function getPlayerClientsForAttempt(attempt: number): Array<
  "WEB" | "WEB_EMBEDDED" | "TV" | "IOS" | "ANDROID"
> {
  const variants: Array<Array<"WEB" | "WEB_EMBEDDED" | "TV" | "IOS" | "ANDROID">> = [
    ["WEB_EMBEDDED", "IOS", "ANDROID", "TV"],
    ["ANDROID", "IOS", "TV", "WEB"],
    ["TV", "IOS", "ANDROID", "WEB_EMBEDDED"],
  ];

  return variants[Math.min(attempt, variants.length - 1)];
}

export function shouldEnableYtDlpFallback(): boolean {
  return parseBooleanFlag(process.env.YOUTUBE_ENABLE_YTDLP_FALLBACK, true);
}

function getYtDlpBin(): string {
  return process.env.YTDLP_BIN?.trim() || "yt-dlp";
}

async function hasYtDlpOption(bin: string, optionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(bin, ["--help"], {
      maxBuffer: 12 * 1024 * 1024,
    });
    return stdout.includes(optionName);
  } catch (error) {
    logger.warn("ytdlp_help_probe_failed", {
      bin,
      optionName,
      message: error instanceof Error ? error.message : "unknown_error",
    });
    return false;
  }
}

async function ensureYtDlpNightlyBin(): Promise<string> {
  const targetPath = path.join(getStorageRootDir(), "bin", "yt-dlp-nightly");
  const targetDir = path.dirname(targetPath);

  try {
    const existing = await stat(targetPath);
    if (existing.isFile() && existing.size > 0) {
      return targetPath;
    }
  } catch {
    // file not found; continue to download
  }

  logger.info("ytdlp_nightly_download_started", { targetPath, url: YTDLP_NIGHTLY_URL });
  const response = await fetch(YTDLP_NIGHTLY_URL, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Gagal download yt-dlp nightly (${response.status})`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(targetDir, { recursive: true });
  await writeFile(targetPath, bytes);
  await chmod(targetPath, 0o755);

  logger.info("ytdlp_nightly_download_completed", { targetPath, sizeBytes: bytes.length });
  return targetPath;
}

async function resolveYtDlpBinForFallback(): Promise<string> {
  const configured = process.env.YTDLP_BIN?.trim();
  if (configured) {
    return configured;
  }

  const systemBin = getYtDlpBin();
  const forceNightly = parseBooleanFlag(process.env.YTDLP_FORCE_NIGHTLY, false);
  const autoBootstrapNightly = parseBooleanFlag(process.env.YTDLP_AUTO_BOOTSTRAP_NIGHTLY, true);

  if (forceNightly) {
    try {
      return await ensureYtDlpNightlyBin();
    } catch (error) {
      logger.warn("ytdlp_force_nightly_failed_fallback_system_bin", {
        message: error instanceof Error ? error.message : "unknown_error",
      });
      return systemBin;
    }
  }

  if (!autoBootstrapNightly) {
    return systemBin;
  }

  const [supportsRemote, supportsJsRuntime] = await Promise.all([
    hasYtDlpOption(systemBin, "--remote-components"),
    hasYtDlpOption(systemBin, "--js-runtimes"),
  ]);

  if (supportsRemote && supportsJsRuntime) {
    return systemBin;
  }

  try {
    const nightly = await ensureYtDlpNightlyBin();
    logger.info("ytdlp_auto_bootstrap_nightly_enabled", {
      from: systemBin,
      to: nightly,
      supportsRemote,
      supportsJsRuntime,
    });
    return nightly;
  } catch (error) {
    logger.warn("ytdlp_auto_bootstrap_failed_use_system_bin", {
      message: error instanceof Error ? error.message : "unknown_error",
      supportsRemote,
      supportsJsRuntime,
    });
    return systemBin;
  }
}

function getYtDlpJsRuntimeArgs(): string[] {
  const enabled = parseBooleanFlag(process.env.YTDLP_JS_RUNTIME_ENABLED, true);
  if (!enabled) {
    return [];
  }

  const runtime = process.env.YTDLP_JS_RUNTIME?.trim() || "node";
  return ["--js-runtimes", runtime];
}

export function getYtDlpRemoteComponentsArgs(): string[] {
  const enabled = parseBooleanFlag(process.env.YTDLP_REMOTE_COMPONENTS_ENABLED, true);
  if (!enabled) {
    return [];
  }

  const source = process.env.YTDLP_REMOTE_COMPONENTS_SOURCE?.trim() || "ejs:github";
  return ["--remote-components", source];
}

export function getYtDlpPlayerClientArg(playerClients: string): string {
  return `youtube:player_client=${playerClients}`;
}

export function getYtDlpExtractorArgVariants(): string[] {
  const fromEnv = (process.env.YTDLP_EXTRACTOR_ARG_VARIANTS || "")
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const defaults = [
    getYtDlpPlayerClientArg("android"),
    getYtDlpPlayerClientArg("android,ios,tv,web"),
    getYtDlpPlayerClientArg("tv,web_safari,android,ios"),
    getYtDlpPlayerClientArg("default,-ios"),
    getYtDlpPlayerClientArg("web_safari,android_vr,tv"),
  ];

  const merged = fromEnv.length > 0 ? [...fromEnv, ...defaults] : defaults;
  return [...new Set(merged)];
}

function getYtDlpFormatFallbacks(): string[] {
  const fromEnv = (process.env.YTDLP_FORMAT_FALLBACKS || "")
    .split("|")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const defaults = ["bv+ba/b", "b/bv+ba", "b"];
  const merged = fromEnv.length > 0 ? [...fromEnv, ...defaults] : defaults;
  return [...new Set(merged)];
}

export function extractYoutubeVideoIdFromUrl(url: string): string | null {
  try {
    return ytdl.getURLVideoID(url);
  } catch {
    const patterns = [
      /youtu\.be\/([a-zA-Z0-9_-]{11})/i,
      /[?&]v=([a-zA-Z0-9_-]{11})/i,
      /\/shorts\/([a-zA-Z0-9_-]{11})/i,
      /\/embed\/([a-zA-Z0-9_-]{11})/i,
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }
  }

  return null;
}

export async function findDownloadedFileByCreatedAt(
  rootDir: string,
  createdAt: number,
  preferredVideoId?: string | null
): Promise<string | null> {
  const youtubeDir = path.join(rootDir, "youtube");
  const suffix = `-${createdAt}`;

  let files: string[] = [];
  try {
    files = await readdir(youtubeDir);
  } catch {
    return null;
  }

  const matches = files
    .filter((filename) => filename.includes(suffix))
    .map((filename) => path.join(youtubeDir, filename));

  if (matches.length === 0) {
    return null;
  }

  const ranked = await Promise.all(
    matches.map(async (candidatePath) => {
      try {
        const info = await stat(candidatePath);
        return {
          path: candidatePath,
          mtimeMs: info.mtimeMs,
          preferred:
            Boolean(preferredVideoId) &&
            path.basename(candidatePath).toLowerCase().startsWith(`${String(preferredVideoId).toLowerCase()}-`),
        };
      } catch {
        return null;
      }
    })
  );

  const available = ranked.filter(
    (item): item is { path: string; mtimeMs: number; preferred: boolean } => item !== null
  );

  if (available.length === 0) {
    return null;
  }

  available.sort((a, b) => {
    if (a.preferred !== b.preferred) {
      return a.preferred ? -1 : 1;
    }
    return b.mtimeMs - a.mtimeMs;
  });

  return available[0].path;
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

function extractExecErrorText(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error || "");
  }

  const err = error as {
    message?: string;
    stderr?: string | Buffer;
    stdout?: string | Buffer;
  };

  const stderr =
    typeof err.stderr === "string"
      ? err.stderr
      : Buffer.isBuffer(err.stderr)
        ? err.stderr.toString("utf8")
        : "";
  const stdout =
    typeof err.stdout === "string"
      ? err.stdout
      : Buffer.isBuffer(err.stdout)
        ? err.stdout.toString("utf8")
        : "";
  const message = err.message || "";

  return [message, stderr, stdout].filter((part) => part.trim().length > 0).join("\n");
}

function hasNoSuchOptionError(errorText: string, optionName: string): boolean {
  const lower = errorText.toLowerCase();
  return lower.includes("no such option") && lower.includes(optionName.toLowerCase());
}

function isYtDlpTransientError(errorText: string): boolean {
  return (
    isRateLimitedError(errorText) ||
    isBotCheckError(errorText) ||
    isForbiddenError(errorText) ||
    errorText.toLowerCase().includes("http error 5")
  );
}

function compactErrorText(errorText: string, maxLines = 8): string {
  const lines = errorText
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const focused = lines.filter((line) =>
    /error|warning|forbidden|too many requests|not a bot|precondition/i.test(line)
  );
  const source = focused.length > 0 ? focused : lines;
  const compact = source.slice(-maxLines).join(" | ");

  return compact || "unknown_error";
}

async function runYtDlpCommandWithRetry(
  bin: string,
  args: string[],
  retries: number,
  context: Record<string, unknown>
): Promise<
  | { ok: true; stdout: string }
  | {
      ok: false;
      errorText: string;
      unsupportedOption: "--remote-components" | "--js-runtimes" | null;
    }
> {
  const maxRetries = Math.max(0, retries);
  const retryBaseMs = getYtDlpRetryConfig().baseDelayMs;
  let lastErrorText = "";

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const { stdout } = await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024 });
      return { ok: true, stdout };
    } catch (error) {
      const errorText = extractExecErrorText(error);
      lastErrorText = errorText;
      const remoteOptionUnsupported = hasNoSuchOptionError(errorText, "--remote-components");
      const jsRuntimeOptionUnsupported = hasNoSuchOptionError(errorText, "--js-runtimes");
      const unsupportedOption = remoteOptionUnsupported
        ? "--remote-components"
        : jsRuntimeOptionUnsupported
          ? "--js-runtimes"
          : null;

      logger.warn("ytdlp_command_failed", {
        ...context,
        attempt,
        maxRetries,
        unsupportedOption,
        message: compactErrorText(errorText, 3),
      });

      if (unsupportedOption) {
        return {
          ok: false,
          errorText,
          unsupportedOption,
        };
      }

      if (attempt >= maxRetries || !isYtDlpTransientError(errorText)) {
        break;
      }

      const waitMs = getRetryDelayMs(retryBaseMs, attempt + 1);
      await delay(waitMs);
    }
  }

  return {
    ok: false,
    errorText: lastErrorText || "yt-dlp command failed",
    unsupportedOption: null,
  };
}

export async function downloadYoutubeVideoWithYtDlp(url: string) {
  const root = getStorageRootDir();
  const createdAt = Date.now();
  const outputTemplate = path.join(root, "youtube", `%(id)s-${createdAt}.%(ext)s`);
  await mkdir(path.dirname(outputTemplate), { recursive: true });

  const ytDlpBin = await resolveYtDlpBinForFallback();
  const retryConfig = getYtDlpRetryConfig();
  const videoIdFromUrl = extractYoutubeVideoIdFromUrl(url);
  const extractorArgVariants = getYtDlpExtractorArgVariants();
  const formatFallbacks = getYtDlpFormatFallbacks();
  const cookieFilePath = await buildYtDlpCookieFilePath();
  const tryCookies = parseBooleanFlag(process.env.YTDLP_TRY_COOKIES, false);
  const commonArgsBase = [
    "--no-playlist",
    ...getYoutubeExternalDownloaderProxyArgs(),
  ];
  const cookieArgsVariants: string[][] =
    cookieFilePath && tryCookies ? [[], ["--cookies", cookieFilePath]] : [[]];
  const jsRuntimeArgsEnabled = getYtDlpJsRuntimeArgs();
  let jsRuntimeArgsVariants: string[][] = jsRuntimeArgsEnabled.length > 0 ? [jsRuntimeArgsEnabled, []] : [[]];
  const remoteArgsEnabled = getYtDlpRemoteComponentsArgs();
  let remoteArgsVariants: string[][] = remoteArgsEnabled.length > 0 ? [remoteArgsEnabled, []] : [[]];
  let infoResult: YtDlpVideoInfo | null = null;
  let lastInfoError = "";

  try {
    infoLoop: for (const cookieArgs of cookieArgsVariants) {
      for (const jsRuntimeArgs of jsRuntimeArgsVariants) {
        for (const remoteArgs of remoteArgsVariants) {
          for (const extractorArg of extractorArgVariants) {
            const infoArgs = [
              ...commonArgsBase,
              ...cookieArgs,
              ...jsRuntimeArgs,
              ...remoteArgs,
              "--extractor-args",
              extractorArg,
              "--dump-single-json",
              url,
            ];

            logger.info("ytdlp_info_started", {
              bin: ytDlpBin,
              cookieMode: cookieArgs.length > 0 ? "with_cookie" : "no_cookie",
              jsRuntime: jsRuntimeArgs.length > 0 ? jsRuntimeArgs[1] : null,
              remoteComponents: remoteArgs.length > 0 ? remoteArgs[1] : null,
              extractorArg,
            });

            const infoExec = await runYtDlpCommandWithRetry(
              ytDlpBin,
              infoArgs,
              retryConfig.infoMaxRetries,
              {
                stage: "info",
                cookieMode: cookieArgs.length > 0 ? "with_cookie" : "no_cookie",
                extractorArg,
                jsRuntimeEnabled: jsRuntimeArgs.length > 0,
                remoteComponentsEnabled: remoteArgs.length > 0,
              }
            );

            if (!infoExec.ok) {
              lastInfoError = infoExec.errorText;

              if (infoExec.unsupportedOption === "--js-runtimes" && jsRuntimeArgs.length > 0) {
                jsRuntimeArgsVariants = [[]];
                logger.warn("ytdlp_js_runtime_option_unsupported", {
                  fallback: "retry_without_js_runtimes_arg",
                });
                continue infoLoop;
              }

              if (infoExec.unsupportedOption === "--remote-components" && remoteArgs.length > 0) {
                remoteArgsVariants = [[]];
                logger.warn("ytdlp_remote_components_unsupported", {
                  fallback: "retry_without_remote_components",
                });
                continue;
              }
              continue;
            }

            try {
              infoResult = JSON.parse(infoExec.stdout.trim()) as YtDlpVideoInfo;
              logger.info("ytdlp_info_completed", {
                videoId: infoResult.id || null,
                title: infoResult.title || null,
                extractorArg,
              });
              break infoLoop;
            } catch (error) {
              lastInfoError = error instanceof Error ? error.message : "Gagal parse output yt-dlp --dump-single-json";
              logger.warn("ytdlp_info_parse_failed", { extractorArg, message: lastInfoError });
            }
          }
        }
      }
    }

    if (!infoResult && lastInfoError) {
      logger.warn("ytdlp_info_unavailable_continue_download", {
        message: compactErrorText(lastInfoError, 3),
      });
    }

    let downloadSucceeded = false;
    let lastDownloadError = "";

    downloadLoop: for (const cookieArgs of cookieArgsVariants) {
      for (const jsRuntimeArgs of jsRuntimeArgsVariants) {
        for (const remoteArgs of remoteArgsVariants) {
          for (const extractorArg of extractorArgVariants) {
            for (const format of formatFallbacks) {
              const downloadArgs = [
                ...commonArgsBase,
                ...cookieArgs,
                ...jsRuntimeArgs,
                ...remoteArgs,
                "--extractor-args",
                extractorArg,
                "-f",
                format,
                "--merge-output-format",
                "mp4",
                "-o",
                outputTemplate,
                url,
              ];

              logger.info("ytdlp_download_started", {
                bin: ytDlpBin,
                outputTemplate,
                format,
                cookieMode: cookieArgs.length > 0 ? "with_cookie" : "no_cookie",
                extractorArg,
                jsRuntime: jsRuntimeArgs.length > 0 ? jsRuntimeArgs[1] : null,
                remoteComponents: remoteArgs.length > 0 ? remoteArgs[1] : null,
              });

              const downloadExec = await runYtDlpCommandWithRetry(
                ytDlpBin,
                downloadArgs,
                retryConfig.downloadMaxRetries,
                {
                  stage: "download",
                  cookieMode: cookieArgs.length > 0 ? "with_cookie" : "no_cookie",
                  format,
                  extractorArg,
                  jsRuntimeEnabled: jsRuntimeArgs.length > 0,
                  remoteComponentsEnabled: remoteArgs.length > 0,
                }
              );

              if (!downloadExec.ok) {
                lastDownloadError = downloadExec.errorText;

                if (downloadExec.unsupportedOption === "--js-runtimes" && jsRuntimeArgs.length > 0) {
                  jsRuntimeArgsVariants = [[]];
                  logger.warn("ytdlp_js_runtime_option_unsupported", {
                    fallback: "retry_without_js_runtimes_arg",
                  });
                  continue downloadLoop;
                }

                if (downloadExec.unsupportedOption === "--remote-components" && remoteArgs.length > 0) {
                  remoteArgsVariants = [[]];
                  logger.warn("ytdlp_remote_components_unsupported", {
                    fallback: "retry_without_remote_components",
                  });
                  continue;
                }
                continue;
              }

              downloadSucceeded = true;
              break downloadLoop;
            }
          }
        }
      }
    }

    if (!downloadSucceeded) {
      throw new Error(
        `Fallback yt-dlp gagal mengunduh video. ${
          compactErrorText(lastDownloadError || lastInfoError || "Tidak ada kombinasi extractor/format yang berhasil.")
        }`
      );
    }

    const outputPath = await findDownloadedFileByCreatedAt(root, createdAt, infoResult?.id || videoIdFromUrl);
    if (!outputPath) {
      throw new Error("Fallback yt-dlp selesai dijalankan, tapi file output tidak ditemukan.");
    }

    const storageKey = path.relative(root, outputPath).replace(/\\/g, "/");
    const ext = path.extname(outputPath).replace(".", "").toLowerCase();
    const outputFileName = path.basename(outputPath);
    const markerIndex = outputFileName.indexOf(`-${createdAt}`);
    const fallbackVideoIdFromFilename = markerIndex > 0 ? outputFileName.slice(0, markerIndex) : null;
    const videoId =
      infoResult?.id?.trim() || videoIdFromUrl || fallbackVideoIdFromFilename || `unknown-${createdAt}`;

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
      durationMs: Math.max(1, Math.floor((infoResult?.duration || 0) * 1000)),
      videoId,
      title: infoResult?.title || videoId,
      channelName: infoResult?.channel || infoResult?.uploader || null,
      fps: typeof infoResult?.fps === "number" ? infoResult.fps : null,
      width: typeof infoResult?.width === "number" ? infoResult.width : null,
      height: typeof infoResult?.height === "number" ? infoResult.height : null,
      mimeType: ext ? `video/${ext}` : null,
      bitrateKbps: typeof infoResult?.tbr === "number" ? Math.round(infoResult.tbr) : null,
      sampleRate: typeof infoResult?.asr === "number" ? Math.round(infoResult.asr) : null,
      channels: typeof infoResult?.audio_channels === "number" ? infoResult.audio_channels : null,
      videoCodec: infoResult?.vcodec || null,
      audioCodec: infoResult?.acodec || null,
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

export async function buildYoutubeRequestOptions(opts?: {
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
    options.agent =
      cookies && cookies.length > 0 ? ytdl.createProxyAgent(proxyUrl, cookies) : ytdl.createProxyAgent(proxyUrl);
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

export function toFriendlyYoutubeError(error: unknown): Error {
  const rawMessage = error instanceof Error ? error.message : "Gagal mengambil data video YouTube";
  const lower = rawMessage.toLowerCase();

  if (
    lower.includes("sign in to confirm you’re not a bot") ||
    lower.includes("sign in to confirm you're not a bot")
  ) {
    return new Error(
      "YouTube memblokir request (bot check). Sistem sudah mencoba beberapa strategi fallback (yt-dlp + multi extractor/format). Jika masih gagal, update yt-dlp ke nightly, aktifkan runtime JS/EJS, atau gunakan IP berbeda."
    );
  }

  if (lower.includes("429") || lower.includes("too many requests")) {
    return new Error(
      "YouTube rate limit (429). Coba lagi beberapa saat, kurangi frekuensi request, atau ganti IP."
    );
  }

  return new Error(rawMessage);
}
