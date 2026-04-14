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

  const clips = await prisma.clip.findMany({
    where: {
      status: "ready",
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 48,
    select: {
      id: true,
      startMs: true,
      endMs: true,
      outputFileKey: true,
      thumbnailKey: true,
      subtitleMode: true,
      createdAt: true,
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

  return (
    <DashboardShell activeSection="library">
      <LibraryMain clips={clips} />
    </DashboardShell>
  );
}
