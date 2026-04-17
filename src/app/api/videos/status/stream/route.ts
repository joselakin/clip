import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { pipelineEventBus, type PipelineEvent } from "@/lib/pipeline-events";
import { getPipelineStatusByVideoId } from "@/lib/pipeline-status";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function toSseMessage(event: PipelineEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
}

export async function GET(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!isValidSessionToken(token)) {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const videoId = request.nextUrl.searchParams.get("videoId")?.trim() ?? "";
  if (!videoId) {
    return NextResponse.json({ ok: false, message: "videoId wajib diisi" }, { status: 400 });
  }

  const initialPipeline = await getPipelineStatusByVideoId(prisma, videoId);
  if (!initialPipeline) {
    return NextResponse.json({ ok: false, message: "Video tidak ditemukan" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let lastPipelineJson = JSON.stringify(initialPipeline);

  let onAbort: (() => void) | null = null;

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (onAbort) {
      request.signal.removeEventListener("abort", onAbort);
      onAbort = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        cleanup();
        controller.close();
      };

      const safeEnqueue = (event: PipelineEvent) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(toSseMessage(event)));
        } catch {
          cleanup();
        }
      };

      onAbort = () => {
        close();
      };

      request.signal.addEventListener("abort", onAbort, { once: true });

      safeEnqueue({
        type: "snapshot",
        payload: { ok: true, videoId, pipeline: initialPipeline },
      });

      unsubscribe = pipelineEventBus.subscribe(videoId, (event) => {
        safeEnqueue(event);
      });

      heartbeatTimer = setInterval(() => {
        safeEnqueue({
          type: "heartbeat",
          payload: { videoId, at: new Date().toISOString() },
        });
      }, 15000);

      statusPollTimer = setInterval(async () => {
        if (closed) {
          return;
        }
        try {
          const latest = await getPipelineStatusByVideoId(prisma, videoId);
          if (!latest) {
            close();
            return;
          }
          const latestJson = JSON.stringify(latest);
          if (latestJson !== lastPipelineJson) {
            lastPipelineJson = latestJson;
            safeEnqueue({
              type: "status_update",
              payload: { ok: true, videoId, pipeline: latest },
            });
          }
        } catch {
          cleanup();
        }
      }, 3000);

    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
