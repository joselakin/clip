#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import ytdl from "@distube/ytdl-core";

const TARGET_URL = process.argv[2] || "https://youtu.be/YtDI-dXfP5Q";
const ROOT = process.cwd();

function parseEnv(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return {};
  return parseEnv(await readFile(envPath, "utf8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCookiesFromEnv(env) {
  const filePath = env.YOUTUBE_COOKIES_FILE?.trim();
  if (!filePath) return null;

  const abs = path.isAbsolute(filePath) ? filePath : path.join(ROOT, filePath);
  if (!existsSync(abs)) return null;

  const raw = await readFile(abs, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return null;
  return parsed;
}

async function testYtdlCoreNoCookie(env) {
  const userAgent =
    env.YOUTUBE_USER_AGENT ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const options = {
    requestOptions: {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    playerClients: ["WEB_EMBEDDED", "IOS", "ANDROID", "TV"],
  };

  const started = await testYtdlStart(TARGET_URL, options, "ytdl-core/no-cookie");
  return started;
}

async function testYtdlCoreWithCookie(env) {
  const cookies = await readCookiesFromEnv(env);
  if (!cookies || cookies.length === 0) {
    return { ok: false, reason: "cookies tidak tersedia" };
  }

  const userAgent =
    env.YOUTUBE_USER_AGENT ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  const options = {
    requestOptions: {
      headers: {
        "User-Agent": userAgent,
        "Accept-Language": "en-US,en;q=0.9",
      },
    },
    playerClients: ["WEB", "WEB_EMBEDDED", "IOS", "ANDROID", "TV"],
    agent: ytdl.createAgent(cookies),
  };

  const started = await testYtdlStart(TARGET_URL, options, "ytdl-core/with-cookie");
  return started;
}

async function testYtdlStart(url, options) {
  try {
    const info = await ytdl.getInfo(url, options);
    const stream = ytdl.downloadFromInfo(info, {
      quality: "lowest",
      filter: "audioandvideo",
      ...options,
    });

    let started = false;
    let bytes = 0;

    const done = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        stream.destroy();
        if (started) {
          resolve({ ok: true, reason: `mulai download (${bytes} bytes terbaca)` });
        } else {
          resolve({ ok: false, reason: "timeout sebelum data masuk" });
        }
      }, 15000);

      stream.on("data", (chunk) => {
        started = true;
        bytes += chunk.length;
        clearTimeout(timeout);
        stream.destroy();
        resolve({ ok: true, reason: `mulai download (${bytes} bytes terbaca)` });
      });

      stream.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      stream.on("close", () => {
        clearTimeout(timeout);
        if (!started) {
          resolve({ ok: false, reason: "stream tertutup sebelum ada data" });
        }
      });
    });

    return await done;
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "error tidak diketahui",
    };
  }
}

async function testYtDlp(env) {
  const bin = env.YTDLP_BIN?.trim() || "yt-dlp";
  const proxy = env.YOUTUBE_PROXY_URL?.trim();

  const args = ["--no-playlist", "--newline", "-f", "bv*+ba/b", "-o", "/tmp/yt-test-%(id)s.%(ext)s", TARGET_URL];
  if (proxy) {
    args.unshift(proxy);
    args.unshift("--proxy");
  }

  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let started = false;
    let errorText = "";

    const onLine = (text) => {
      const lower = text.toLowerCase();
      if (lower.includes("destination") || lower.includes("[download]") && lower.includes("%")) {
        started = true;
        child.kill("SIGTERM");
      }
      errorText += `${text}\n`;
    };

    child.stdout.on("data", (buf) => onLine(String(buf)));
    child.stderr.on("data", (buf) => onLine(String(buf)));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: started, reason: started ? "mulai download (detected progress log)" : "timeout" });
    }, 20000);

    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, reason: error.message });
    });

    child.on("close", () => {
      clearTimeout(timeout);
      if (started) {
        resolve({ ok: true, reason: "mulai download (detected progress log)" });
        return;
      }
      const compact = errorText.trim().split(/\r?\n/).slice(-4).join(" | ");
      resolve({ ok: false, reason: compact || "proses selesai tanpa indikasi download" });
    });
  });
}

function normalizeDownloaderMode(value) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "hybrid") return "hybrid";
  if (normalized === "ytdl-core-primary") return "ytdl-core-primary";
  return "yt-dlp-primary";
}

function getConfiguredLabelsForMode(downloaderMode) {
  if (downloaderMode === "ytdl-core-primary") {
    return ["ytdl-core/no-cookie", "ytdl-core/with-cookie", "yt-dlp-primary"];
  }
  if (downloaderMode === "hybrid") {
    return ["yt-dlp-primary", "ytdl-core/with-cookie", "ytdl-core/no-cookie"];
  }
  return ["yt-dlp-primary", "ytdl-core/with-cookie", "ytdl-core/no-cookie"];
}

function getRecommendedResult(results, downloaderMode) {
  const configuredLabels = getConfiguredLabelsForMode(downloaderMode);

  for (const label of configuredLabels) {
    const preferred = results.find(([name, result]) => name === label && result.ok);
    if (preferred) {
      return preferred;
    }
  }

  return results.find(([, result]) => result.ok) || null;
}

async function main() {
  const env = await loadEnv();
  const configuredMode = env.YOUTUBE_DOWNLOADER_MODE?.trim() || "yt-dlp-primary";
  const downloaderMode = normalizeDownloaderMode(configuredMode);

  const results = [];
  results.push(["ytdl-core/no-cookie", await testYtdlCoreNoCookie(env)]);
  results.push(["ytdl-core/with-cookie", await testYtdlCoreWithCookie(env)]);

  await sleep(250);
  results.push(["yt-dlp-primary", await testYtDlp(env)]);

  console.log(`URL: ${TARGET_URL}`);
  console.log(`YOUTUBE_DOWNLOADER_MODE (configured): ${configuredMode}`);
  console.log(`YOUTUBE_DOWNLOADER_MODE (normalized): ${downloaderMode}`);
  console.log("--- HASIL TEST DOWNLOADER ---");

  const configuredLabels = getConfiguredLabelsForMode(downloaderMode);
  const primaryLabel = configuredLabels[0] ?? null;

  for (const [name, result] of results) {
    const status = result.ok ? "PASS" : "FAIL";
    const modeLabel = name === primaryLabel ? "primary" : configuredLabels.includes(name) ? "fallback" : "alternate";
    console.log(`${status} ${name} [${modeLabel}] -> ${result.reason}`);
  }

  const winner = getRecommendedResult(results, downloaderMode);
  if (winner) {
    const recommendationLabel = winner[0] === primaryLabel
      ? `primary path for ${downloaderMode}`
      : configuredLabels.includes(winner[0])
        ? `recommended fallback for ${downloaderMode}`
        : `alternate path outside ${downloaderMode}`;
    console.log(`REKOMENDASI: pakai ${winner[0]} (${recommendationLabel}, sudah terbukti mulai download).`);
    process.exit(0);
  }

  console.log(`REKOMENDASI: mode ${downloaderMode} tidak punya path yang bisa mulai download di environment/IP ini.`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
