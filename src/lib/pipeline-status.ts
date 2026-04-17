import type { JobType } from "@prisma/client";

export type PipelineStepId = "download" | "transcribe" | "highlight" | "render";
export type PipelineStepStatus = "pending" | "running" | "done" | "error";
export type PipelineOverallStatus = "idle" | "running" | "success" | "failed";

export type PipelineStatus = {
  overall: PipelineOverallStatus;
  steps: Array<{ id: PipelineStepId; status: PipelineStepStatus; detail: string }>;
  updatedAtIso: string;
};

type RawJobRow = {
  jobType: string;
  status: string;
  errorMessage: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  startedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

type RawHighlightRun = {
  status?: string | null;
  errorMessage?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  finishedAt?: Date | string | null;
};

type VideoMetadataRecord = Record<string, unknown>;

type PipelineStatusVideoRecord = {
  id: string;
  metadata: unknown;
  updatedAt: Date | string | null;
};

type PipelineStatusPrismaLike = {
  video: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; metadata: true; updatedAt: true };
    }): Promise<PipelineStatusVideoRecord | null>;
  };
  job: {
    findMany(args: {
      where: { videoId: string; jobType: { in: JobType[] } };
      select: {
        jobType: true;
        status: true;
        errorMessage: true;
        createdAt: true;
        updatedAt: true;
        startedAt: true;
        finishedAt: true;
      };
      orderBy: { createdAt: "desc" };
    }): Promise<RawJobRow[]>;
  };
  highlightSelectionRun: {
    findFirst(args: {
      where: { videoId: string };
      select: {
        status: true;
        errorMessage: true;
        createdAt: true;
        updatedAt: true;
        finishedAt: true;
      };
      orderBy: { createdAt: "desc" };
    }): Promise<RawHighlightRun | null>;
  };
};

export async function getPipelineStatusByVideoId(
  prismaLike: PipelineStatusPrismaLike,
  videoId: string
): Promise<PipelineStatus | null> {
  const video = await prismaLike.video.findUnique({
    where: { id: videoId },
    select: { id: true, metadata: true, updatedAt: true },
  });

  if (!video) {
    return null;
  }

  const jobs = await prismaLike.job.findMany({
    where: {
      videoId,
      jobType: {
        in: ["TRANSCRIBE", "HIGHLIGHT", "RENDER_CLIP"] satisfies JobType[],
      },
    },
    select: {
      jobType: true,
      status: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      startedAt: true,
      finishedAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const highlightRun = await prismaLike.highlightSelectionRun.findFirst({
    where: { videoId },
    select: {
      status: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      finishedAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return buildPipelineStatusFromRows({
    jobs,
    videoMetadata: asRecord(video.metadata),
    highlightRun,
    videoUpdatedAt: video.updatedAt,
  });
}

export function buildPipelineStatusFromRows(input: {
  jobs: RawJobRow[];
  videoMetadata: VideoMetadataRecord;
  highlightRun: RawHighlightRun | null;
  videoUpdatedAt?: Date | string | null;
}): PipelineStatus {
  const transcribeJobs = input.jobs.filter((job) => normalizeJobType(job.jobType) === "TRANSCRIBE");
  const highlightJobs = input.jobs.filter((job) => normalizeJobType(job.jobType) === "HIGHLIGHT");
  const renderJobs = input.jobs.filter((job) => normalizeJobType(job.jobType) === "RENDER_CLIP");

  const download = toDownloadStepStatus(input.videoMetadata);
  const transcribe = toStepStatus(transcribeJobs);
  const highlight = toHighlightStepStatus(highlightJobs, input.highlightRun);
  const render = toStepStatus(renderJobs);

  const steps: PipelineStatus["steps"] = [
    {
      id: "download",
      status: download,
      detail:
        download === "error"
          ? "Sumber video gagal diproses"
          : download === "running"
            ? "Sumber video sedang diproses"
            : download === "done"
              ? "Sumber video siap"
              : "Menunggu sumber video",
    },
    {
      id: "transcribe",
      status: transcribe,
      detail:
        transcribe === "error"
          ? "Transkripsi gagal"
          : transcribe === "running"
            ? "Transkripsi sedang berjalan"
            : transcribe === "done"
              ? "Transkripsi selesai"
              : "Menunggu transkripsi",
    },
    {
      id: "highlight",
      status: highlight,
      detail:
        highlight === "error"
          ? "Seleksi highlight gagal"
          : highlight === "running"
            ? "Seleksi highlight sedang berjalan"
            : highlight === "done"
              ? "Seleksi highlight selesai"
              : "Menunggu transkripsi",
    },
    {
      id: "render",
      status: render,
      detail:
        render === "error"
          ? "Render klip gagal"
          : render === "running"
            ? "Render klip sedang berjalan"
            : render === "done"
              ? "Render klip selesai"
              : "Menunggu highlight",
    },
  ];

  return {
    overall: toOverall(steps),
    steps,
    updatedAtIso: deriveUpdatedAtIso(input.jobs, input.highlightRun, input.videoUpdatedAt),
  };
}

function asRecord(value: unknown): VideoMetadataRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as VideoMetadataRecord;
}

function toDownloadStepStatus(videoMetadata: VideoMetadataRecord): PipelineStepStatus {
  const normalizedEntries = Object.entries(videoMetadata).map(([key, value]) => ({
    key: normalizeStatus(key),
    value,
  }));

  const statusEntry = normalizedEntries.find(({ key }) => key.endsWith("status"));
  if (statusEntry && typeof statusEntry.value === "string") {
    const parsed = mapNormalizedStatus(statusEntry.value);
    if (parsed) {
      return parsed;
    }
  }

  const hasReadySource = normalizedEntries.some(({ key, value }) => {
    if (value == null) {
      return false;
    }

    if (typeof value === "string") {
      return value.trim().length > 0 && key.includes("url");
    }

    return key.includes("url") || key.includes("path") || key.includes("file") || key.includes("source");
  });

  return hasReadySource ? "done" : "pending";
}

function toHighlightStepStatus(jobs: RawJobRow[], highlightRun: RawHighlightRun | null): PipelineStepStatus {
  const latestJob = latestByRelevantTimestamp(jobs);
  const latestJobStatus = latestJob ? mapNormalizedStatus(latestJob.status) : null;

  const runStatus = mapNormalizedStatus(highlightRun?.status);
  if (runStatus) {
    return runStatus;
  }

  return latestJobStatus ?? "pending";
}

function toStepStatus(jobs: RawJobRow[]): PipelineStepStatus {
  const latestJob = latestByRelevantTimestamp(jobs);
  if (!latestJob) {
    return "pending";
  }

  return mapNormalizedStatus(latestJob.status) ?? "pending";
}

function toOverall(steps: PipelineStatus["steps"]): PipelineOverallStatus {
  if (steps.some((step) => step.status === "error")) {
    return "failed";
  }

  if (steps.some((step) => step.status === "running")) {
    return "running";
  }

  if (steps.every((step) => step.status === "done")) {
    return "success";
  }

  return "idle";
}

function mapNormalizedStatus(value: string | null | undefined): PipelineStepStatus | null {
  const normalized = normalizeStatus(value);

  if (normalized === "failed" || normalized === "cancelled") {
    return "error";
  }

  if (normalized === "running") {
    return "running";
  }

  if (normalized === "success") {
    return "done";
  }

  return null;
}

function latestByRelevantTimestamp<T extends { createdAt?: Date | string | null; updatedAt?: Date | string | null; startedAt?: Date | string | null; finishedAt?: Date | string | null }>(rows: T[]): T | null {
  if (rows.length === 0) {
    return null;
  }

  return rows
    .map((row, index) => ({
      row,
      index,
      rank: timestampRank(row),
    }))
    .sort((a, b) => (a.rank === b.rank ? b.index - a.index : b.rank - a.rank))[0]?.row ?? null;
}

function timestampRank(row: {
  updatedAt?: Date | string | null;
  finishedAt?: Date | string | null;
  startedAt?: Date | string | null;
  createdAt?: Date | string | null;
}): number {
  return (
    parseTimestamp(row.updatedAt) ??
    parseTimestamp(row.finishedAt) ??
    parseTimestamp(row.startedAt) ??
    parseTimestamp(row.createdAt) ??
    Number.NEGATIVE_INFINITY
  );
}

function parseTimestamp(value: Date | string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function normalizeStatus(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeJobType(value: string): string {
  return value.trim().toUpperCase();
}

function deriveUpdatedAtIso(
  jobs: RawJobRow[],
  highlightRun: RawHighlightRun | null,
  videoUpdatedAt?: Date | string | null
): string {
  const timestamps: Array<number> = [];

  for (const job of jobs) {
    pushTimestamp(timestamps, job.createdAt);
    pushTimestamp(timestamps, job.updatedAt);
    pushTimestamp(timestamps, job.startedAt);
    pushTimestamp(timestamps, job.finishedAt);
  }

  pushTimestamp(timestamps, highlightRun?.createdAt);
  pushTimestamp(timestamps, highlightRun?.updatedAt);
  pushTimestamp(timestamps, highlightRun?.finishedAt);
  pushTimestamp(timestamps, videoUpdatedAt);

  const latest = timestamps.length > 0 ? Math.max(...timestamps) : null;
  return latest !== null ? new Date(latest).toISOString() : new Date().toISOString();
}

function pushTimestamp(target: number[], value: Date | string | null | undefined): void {
  if (!value) {
    return;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isFinite(time)) {
    target.push(time);
  }
}
