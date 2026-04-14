import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/layout/dashboard-shell";
import { LibraryMain } from "@/components/library/library-main";
import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export default async function LibraryPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!isValidSessionToken(token)) {
    redirect("/login");
  }

  const grouped = await prisma.clip.groupBy({
    by: ["videoId"],
    where: {
      status: "ready",
    },
    _count: {
      _all: true,
    },
    _max: {
      createdAt: true,
    },
    orderBy: {
      _max: {
        createdAt: "desc",
      },
    },
    take: 500,
  });

  const videoIds = grouped.map((item) => item.videoId);

  const [videos, latestClips] = await Promise.all([
    prisma.video.findMany({
      where: { id: { in: videoIds } },
      select: {
        id: true,
        sourceTitle: true,
        sourcePlatform: true,
        sourceUrl: true,
      },
    }),
    prisma.clip.findMany({
      where: {
        status: "ready",
        videoId: { in: videoIds },
      },
      orderBy: {
        createdAt: "desc",
      },
      distinct: ["videoId"],
      select: {
        videoId: true,
        thumbnailKey: true,
      },
    }),
  ]);

  const videoMap = new Map(videos.map((video) => [video.id, video]));
  const latestMap = new Map(latestClips.map((clip) => [clip.videoId, clip]));

  const folders = grouped
    .map((item) => {
      const video = videoMap.get(item.videoId);
      if (!video) {
        return null;
      }

      return {
        videoId: item.videoId,
        clipCount: item._count._all,
        latestClipAt: item._max.createdAt?.toISOString() || null,
        thumbnailKey: latestMap.get(item.videoId)?.thumbnailKey || null,
        video,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  return (
    <DashboardShell activeSection="library">
      <LibraryMain folders={folders} />
    </DashboardShell>
  );
}
