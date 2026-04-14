import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 18;
  }
  return Math.min(60, parsed);
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const videoId = request.nextUrl.searchParams.get("videoId")?.trim() || "";
  if (!videoId) {
    return NextResponse.json({ ok: false, message: "videoId wajib diisi" }, { status: 400 });
  }

  const limit = parseLimit(request.nextUrl.searchParams.get("limit"));
  const cursor = request.nextUrl.searchParams.get("cursor")?.trim() || null;

  try {
    const rows = await prisma.clip.findMany({
      where: {
        status: "ready",
        videoId,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor
        ? {
            cursor: { id: cursor },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        startMs: true,
        endMs: true,
        outputFileKey: true,
        thumbnailKey: true,
        subtitleMode: true,
        highlightCandidate: {
          select: {
            scoreTotal: true,
            reasonJson: true,
          },
        },
        video: {
          select: {
            id: true,
            sourceTitle: true,
            sourcePlatform: true,
            sourceUrl: true,
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    const clips = items.map((clip) => {
      const scorePercent = clip.highlightCandidate
        ? Math.round(Number(clip.highlightCandidate.scoreTotal) * 100)
        : null;

      return {
        id: clip.id,
        startMs: clip.startMs,
        endMs: clip.endMs,
        outputFileKey: clip.outputFileKey,
        thumbnailKey: clip.thumbnailKey,
        subtitleMode: clip.subtitleMode,
        highlight: clip.highlightCandidate
          ? {
              scorePercent,
              reasonJson: clip.highlightCandidate.reasonJson,
            }
          : null,
        video: clip.video,
      };
    });

    const nextCursor = hasMore && clips.length > 0 ? clips[clips.length - 1].id : null;

    return NextResponse.json({
      ok: true,
      clips,
      pageInfo: {
        hasMore,
        nextCursor,
      },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        message: "Gagal memuat clips library",
      },
      { status: 500 }
    );
  }
}
