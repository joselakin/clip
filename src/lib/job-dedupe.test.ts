import { describe, expect, it, vi } from "vitest";

import { findRunningJobForStep } from "@/lib/job-dedupe";

describe("findRunningJobForStep", () => {
  it("returns latest running job for the requested step", async () => {
    const runningJob = {
      id: "job-2",
      videoId: "video-1",
      jobType: "TRANSCRIBE" as const,
      status: "running" as const,
      createdAt: new Date("2026-01-01T10:00:00.000Z"),
    };

    const prismaLike = {
      job: {
        findFirst: vi.fn().mockResolvedValue(runningJob),
      },
    };

    const result = await findRunningJobForStep(prismaLike, {
      videoId: "video-1",
      jobType: "TRANSCRIBE",
    });

    expect(result).toEqual(runningJob);
    expect(prismaLike.job.findFirst).toHaveBeenCalledWith({
      where: {
        videoId: "video-1",
        jobType: "TRANSCRIBE",
        status: "running",
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  });

  it("returns null when no running job exists", async () => {
    const prismaLike = {
      job: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };

    const result = await findRunningJobForStep(prismaLike, {
      videoId: "video-1",
      jobType: "HIGHLIGHT",
    });

    expect(result).toBeNull();
    expect(prismaLike.job.findFirst).toHaveBeenCalledWith({
      where: {
        videoId: "video-1",
        jobType: "HIGHLIGHT",
        status: "running",
      },
      orderBy: {
        createdAt: "desc",
      },
    });
  });
});
