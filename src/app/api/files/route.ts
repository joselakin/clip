import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { resolveStoragePath } from "@/lib/storage";

export const runtime = "nodejs";

function inferContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".mp4":
      return "video/mp4";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".srt":
      return "application/x-subrip";
    case ".ass":
      return "text/x-ssa";
    default:
      return "application/octet-stream";
  }
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const key = request.nextUrl.searchParams.get("key")?.trim();
  const download = request.nextUrl.searchParams.get("download") === "1";

  if (!key) {
    return NextResponse.json({ ok: false, message: "key wajib diisi" }, { status: 400 });
  }

  if (key.includes("..") || path.isAbsolute(key)) {
    return NextResponse.json({ ok: false, message: "Invalid key" }, { status: 400 });
  }

  const filePath = resolveStoragePath(key);

  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return NextResponse.json({ ok: false, message: "File tidak ditemukan" }, { status: 404 });
    }

    const contentType = inferContentType(filePath);
    const totalSize = fileStat.size;
    const rangeHeader = request.headers.get("range");

    if (rangeHeader && contentType.startsWith("video/")) {
      const bytesPrefix = "bytes=";
      if (!rangeHeader.startsWith(bytesPrefix)) {
        return NextResponse.json({ ok: false, message: "Range tidak valid" }, { status: 416 });
      }

      const [startRaw, endRaw] = rangeHeader.slice(bytesPrefix.length).split("-");
      const start = Number.parseInt(startRaw, 10);
      const end = endRaw ? Number.parseInt(endRaw, 10) : totalSize - 1;

      if (
        Number.isNaN(start) ||
        Number.isNaN(end) ||
        start < 0 ||
        end < start ||
        end >= totalSize
      ) {
        return NextResponse.json({ ok: false, message: "Range tidak valid" }, { status: 416 });
      }

      const chunkSize = end - start + 1;
      const stream = createReadStream(filePath, { start, end });
      const body = Readable.toWeb(stream) as ReadableStream;

      const headers = new Headers({
        "Content-Type": contentType,
        "Content-Length": String(chunkSize),
        "Content-Range": `bytes ${start}-${end}/${totalSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60",
      });

      if (download) {
        headers.set("Content-Disposition", `attachment; filename=\"${path.basename(filePath)}\"`);
      }

      return new Response(body, {
        status: 206,
        headers,
      });
    }

    const stream = createReadStream(filePath);
    const body = Readable.toWeb(stream) as ReadableStream;

    const headers = new Headers({
      "Content-Type": contentType,
      "Content-Length": String(totalSize),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=60",
    });

    if (download) {
      headers.set("Content-Disposition", `attachment; filename=\"${path.basename(filePath)}\"`);
    }

    return new Response(body, {
      status: 200,
      headers,
    });
  } catch {
    return NextResponse.json({ ok: false, message: "File tidak ditemukan" }, { status: 404 });
  }
}
