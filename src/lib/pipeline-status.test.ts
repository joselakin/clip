import { describe, expect, it } from "vitest";

import { buildPipelineStatusFromRows, getPipelineStatusByVideoId } from "@/lib/pipeline-status";
import {
  createPipelineEventBus,
  pipelineEventBus,
  publishPipelineStatusUpdate,
  type PipelineEvent,
} from "@/lib/pipeline-events";

describe("createPipelineEventBus", () => {
  it("delivers published status updates to subscribers", () => {
    const bus = createPipelineEventBus();
    const received: PipelineEvent["type"][] = [];
    const unsubscribe = bus.subscribe("video-1", (event) => {
      received.push(event.type);
    });

    bus.publish("video-1", {
      type: "status_update",
      payload: { overall: "running" },
    });

    expect(received).toEqual(["status_update"]);
    unsubscribe();
  });

  it("stops delivering events after unsubscribe", () => {
    const bus = createPipelineEventBus();
    const received: PipelineEvent["type"][] = [];
    const unsubscribe = bus.subscribe("video-1", (event) => {
      received.push(event.type);
    });

    unsubscribe();
    bus.publish("video-1", { type: "heartbeat", payload: { ts: Date.now() } });

    expect(received).toEqual([]);
  });

  it("supports snapshot, status_update, and heartbeat events", () => {
    const bus = createPipelineEventBus();
    const received: PipelineEvent["type"][] = [];
    bus.subscribe("video-1", (event) => {
      received.push(event.type);
    });

    bus.publish("video-1", { type: "snapshot", payload: { overall: "idle" } });
    bus.publish("video-1", { type: "status_update", payload: { overall: "running" } });
    bus.publish("video-1", { type: "heartbeat", payload: { at: "2026-01-01T00:00:00.000Z" } });

    expect(received).toEqual(["snapshot", "status_update", "heartbeat"]);
  });
});

describe("publishPipelineStatusUpdate", () => {
  it("publishes status_update event with latest pipeline payload", async () => {
    const received: PipelineEvent[] = [];
    const unsubscribe = pipelineEventBus.subscribe("video-1", (event) => {
      received.push(event);
    });

    await publishPipelineStatusUpdate({
      videoId: "video-1",
      getPipelineStatus: async () => ({
        overall: "running",
        steps: [
          { id: "download", status: "done", detail: "Sumber video siap" },
          { id: "transcribe", status: "running", detail: "Transkripsi sedang berjalan" },
          { id: "highlight", status: "pending", detail: "Menunggu transkripsi" },
          { id: "render", status: "pending", detail: "Menunggu highlight" },
        ],
        updatedAtIso: "2026-01-01T00:00:00.000Z",
      }),
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      type: "status_update",
      payload: {
        ok: true,
        videoId: "video-1",
        pipeline: {
          overall: "running",
          steps: [
            { id: "download", status: "done", detail: "Sumber video siap" },
            { id: "transcribe", status: "running", detail: "Transkripsi sedang berjalan" },
            { id: "highlight", status: "pending", detail: "Menunggu transkripsi" },
            { id: "render", status: "pending", detail: "Menunggu highlight" },
          ],
          updatedAtIso: "2026-01-01T00:00:00.000Z",
        },
      },
    });

    unsubscribe();
  });

  it("does not publish when pipeline is unavailable", async () => {
    const received: PipelineEvent[] = [];
    const unsubscribe = pipelineEventBus.subscribe("video-1", (event) => {
      received.push(event);
    });

    await publishPipelineStatusUpdate({
      videoId: "video-1",
      getPipelineStatus: async () => null,
    });

    expect(received).toEqual([]);
    unsubscribe();
  });
});

describe("getPipelineStatusByVideoId", () => {
  it("returns null when video does not exist", async () => {
    const prismaLike = {
      video: {
        findUnique: async () => null,
      },
      job: {
        findMany: async () => [],
      },
      highlightSelectionRun: {
        findFirst: async () => null,
      },
    };

    const result = await getPipelineStatusByVideoId(prismaLike, "video-404");
    expect(result).toBeNull();
  });

  it("builds pipeline status from video metadata + latest job and highlight run", async () => {
    const prismaLike = {
      video: {
        findUnique: async () => ({
          id: "video-1",
          metadata: { sourceUrl: "https://example.com/video.mp4" },
          updatedAt: "2026-01-01T09:59:00.000Z",
        }),
      },
      job: {
        findMany: async () => [
          {
            jobType: "TRANSCRIBE",
            status: "success",
            errorMessage: null,
            updatedAt: "2026-01-01T10:00:00.000Z",
          },
          {
            jobType: "HIGHLIGHT",
            status: "running",
            errorMessage: null,
            updatedAt: "2026-01-01T10:10:00.000Z",
          },
        ],
      },
      highlightSelectionRun: {
        findFirst: async () => ({
          status: "running",
          errorMessage: null,
          updatedAt: "2026-01-01T10:20:00.000Z",
        }),
      },
    };

    const result = await getPipelineStatusByVideoId(prismaLike, "video-1");
    expect(result).not.toBeNull();
    expect(result?.overall).toBe("running");
    expect(result?.steps.find((step) => step.id === "download")?.status).toBe("done");
    expect(result?.steps.find((step) => step.id === "transcribe")?.status).toBe("done");
    expect(result?.steps.find((step) => step.id === "highlight")?.status).toBe("running");
  });
});

describe("buildPipelineStatusFromRows", () => {
  it("maps running transcribe job into step statuses", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [{ jobType: "TRANSCRIBE", status: "running", errorMessage: null }],
      videoMetadata: {},
      highlightRun: null,
    });

    expect(status.overall).toBe("running");
    expect(status.steps.find((step) => step.id === "download")?.status).toBe("pending");
    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("running");
    expect(status.steps.find((step) => step.id === "highlight")?.status).toBe("pending");
    expect(status.steps.find((step) => step.id === "render")?.status).toBe("pending");
  });

  it("marks pipeline as failed when highlight job fails", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [
        { jobType: "TRANSCRIBE", status: "success", errorMessage: null },
        { jobType: "HIGHLIGHT", status: "failed", errorMessage: "Model timeout" },
      ],
      videoMetadata: {},
      highlightRun: { status: "failed", errorMessage: "Model timeout" },
    });

    expect(status.overall).toBe("failed");
    expect(status.steps.find((step) => step.id === "download")?.status).toBe("pending");
    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("done");
    expect(status.steps.find((step) => step.id === "highlight")?.status).toBe("error");
    expect(status.steps.find((step) => step.id === "render")?.status).toBe("pending");
  });

  it("marks pipeline as success when render finishes", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [
        { jobType: "TRANSCRIBE", status: "success", errorMessage: null },
        { jobType: "HIGHLIGHT", status: "success", errorMessage: null },
        { jobType: "RENDER_CLIP", status: "success", errorMessage: null },
      ],
      videoMetadata: { sourceUrl: "https://example.com/video.mp4" },
      highlightRun: { status: "success", errorMessage: null },
    });

    expect(status.overall).toBe("success");
    expect(status.steps.find((step) => step.id === "download")?.status).toBe("done");
    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("done");
    expect(status.steps.find((step) => step.id === "highlight")?.status).toBe("done");
    expect(status.steps.find((step) => step.id === "render")?.status).toBe("done");
  });

  it("uses latest transcribe attempt so retry after failure is reflected", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [
        {
          jobType: "TRANSCRIBE",
          status: "failed",
          errorMessage: "network",
          updatedAt: "2026-01-01T10:00:00.000Z",
        },
        {
          jobType: "TRANSCRIBE",
          status: "running",
          errorMessage: null,
          updatedAt: "2026-01-01T11:00:00.000Z",
        },
      ],
      videoMetadata: { sourceUrl: "https://example.com/video.mp4" },
      highlightRun: null,
    });

    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("running");
    expect(status.overall).toBe("running");
  });

  it("normalizes mixed-case and whitespace statuses", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [
        { jobType: " transcribe ", status: "  SuCcEsS ", errorMessage: null },
        { jobType: " render_clip ", status: "  running  ", errorMessage: null },
      ],
      videoMetadata: { sourceUrl: "https://example.com/video.mp4" },
      highlightRun: { status: "  RUNNING ", errorMessage: null },
    });

    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("done");
    expect(status.steps.find((step) => step.id === "highlight")?.status).toBe("running");
    expect(status.steps.find((step) => step.id === "render")?.status).toBe("running");
  });

  it("treats unknown statuses as pending", () => {
    const status = buildPipelineStatusFromRows({
      jobs: [{ jobType: "TRANSCRIBE", status: "queued-ish", errorMessage: null }],
      videoMetadata: {},
      highlightRun: { status: "mystery", errorMessage: null },
    });

    expect(status.steps.find((step) => step.id === "download")?.status).toBe("pending");
    expect(status.steps.find((step) => step.id === "transcribe")?.status).toBe("pending");
    expect(status.steps.find((step) => step.id === "highlight")?.status).toBe("pending");
  });

  it("derives updatedAtIso from preferred timestamps and video timestamp fallback", () => {
    const withTimes = buildPipelineStatusFromRows({
      jobs: [
        {
          jobType: "TRANSCRIBE",
          status: "running",
          errorMessage: null,
          createdAt: "2026-01-01T08:00:00.000Z",
          startedAt: "2026-01-01T09:00:00.000Z",
        },
        {
          jobType: "RENDER_CLIP",
          status: "success",
          errorMessage: null,
          finishedAt: "2026-01-01T10:30:00.000Z",
        },
      ],
      videoMetadata: { sourceUrl: "https://example.com/video.mp4" },
      highlightRun: {
        status: "running",
        createdAt: "2026-01-01T09:30:00.000Z",
        updatedAt: "2026-01-01T10:45:00.000Z",
      },
      videoUpdatedAt: "2026-01-01T10:40:00.000Z",
    });

    const fallback = buildPipelineStatusFromRows({
      jobs: [],
      videoMetadata: {},
      highlightRun: null,
      videoUpdatedAt: "2026-01-01T09:15:00.000Z",
    });

    expect(withTimes.updatedAtIso).toBe("2026-01-01T10:45:00.000Z");
    expect(fallback.updatedAtIso).toBe("2026-01-01T09:15:00.000Z");
  });

  it("uses video updatedAt when no job or highlight timestamps exist", async () => {
    const prismaLike = {
      video: {
        findUnique: async () => ({
          id: "video-1",
          metadata: {},
          updatedAt: "2026-01-02T11:00:00.000Z",
        }),
      },
      job: {
        findMany: async () => [],
      },
      highlightSelectionRun: {
        findFirst: async () => null,
      },
    };

    const result = await getPipelineStatusByVideoId(prismaLike, "video-1");
    expect(result?.updatedAtIso).toBe("2026-01-02T11:00:00.000Z");
  });
});
