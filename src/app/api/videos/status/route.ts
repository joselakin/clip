import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { getPipelineStatusByVideoId } from "@/lib/pipeline-status";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const videoId = request.nextUrl.searchParams.get("videoId")?.trim() ?? "";
  if (!videoId) {
    return NextResponse.json({ ok: false, message: "videoId wajib diisi" }, { status: 400 });
  }

  const pipeline = await getPipelineStatusByVideoId(prisma, videoId);
  if (!pipeline) {
    return NextResponse.json({ ok: false, message: "Video tidak ditemukan" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, videoId, pipeline });
}
