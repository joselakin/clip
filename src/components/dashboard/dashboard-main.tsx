"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { HeroSection } from "@/components/dashboard/hero-section";
import { ProduceClipsCta } from "@/components/dashboard/produce-clips-cta";
import { VideoSourceInput } from "@/components/dashboard/video-source-input";
import { WorkflowChips } from "@/components/dashboard/workflow-chips";
import {
  DEFAULT_CLIP_COUNT_TARGET,
  type ClipCountTarget,
  type ClipDurationPreset,
} from "@/lib/clip-duration";
import {
  DEFAULT_EMOTION_CONTEXT,
  type EmotionContext,
} from "@/lib/emotion-context";

type TranscriptLine = {
  startMs: number;
  endMs: number;
  text: string;
};

type HighlightLine = {
  startMs: number;
  endMs: number;
  scoreTotal: number;
  reason: string;
  topic?: string;
};

type RenderedClipLine = {
  id: string;
  startMs: number;
  endMs: number;
  outputFileKey: string;
  subtitleMode?: "none" | "hard";
  subtitleFileKey?: string | null;
  thumbnailKey?: string | null;
};

type PipelineStepId = "download" | "transcribe" | "highlight" | "render";
type PipelineStepStatus = "pending" | "running" | "done" | "error";

type PipelineStep = {
  id: PipelineStepId;
  label: string;
  status: PipelineStepStatus;
  detail: string;
};

type PipelineSnapshot = {
  overall: "idle" | "running" | "success" | "failed";
  steps: Array<{ id: PipelineStepId; status: PipelineStepStatus; detail: string }>;
  updatedAtIso: string;
};

type PipelineStatusResult = {
  ok: boolean;
  videoId: string;
  pipeline: PipelineSnapshot;
};

const DEFAULT_PIPELINE_STEPS: PipelineStep[] = [

  { id: "download", label: "Ingest Video", status: "pending", detail: "Menunggu proses" },
  { id: "transcribe", label: "Transcribe", status: "pending", detail: "Menunggu proses" },
  { id: "highlight", label: "AI Highlights", status: "pending", detail: "Menunggu proses" },
  { id: "render", label: "Crop + Render", status: "pending", detail: "Menunggu proses" },
];

function getStepDotClass(status: PipelineStepStatus): string {
  if (status === "done") {
    return "bg-white";
  }
  if (status === "running") {
    return "bg-white animate-pulse";
  }
  if (status === "error") {
    return "bg-white/50";
  }
  return "bg-white/20";
}

function getStepLabelClass(status: PipelineStepStatus): string {
  if (status === "done") {
    return "text-white";
  }
  if (status === "running") {
    return "text-white";
  }
  if (status === "error") {
    return "text-white/70";
  }
  return "text-white/60";
}

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function DashboardMain() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [renderLayoutMode, setRenderLayoutMode] = useState<"standard" | "framed">("standard");
  const [podcastTwoSpeakerMode, setPodcastTwoSpeakerMode] = useState(false);
  const [watermarkText, setWatermarkText] = useState("");
  const [watermarkLogoFile, setWatermarkLogoFile] = useState<File | null>(null);
  const [clipDurationPreset, setClipDurationPreset] = useState<ClipDurationPreset>("under_1_minute");
  const [clipCountTarget, setClipCountTarget] = useState<ClipCountTarget>(DEFAULT_CLIP_COUNT_TARGET);
  const [emotionContext, setEmotionContext] = useState<EmotionContext>(DEFAULT_EMOTION_CONTEXT);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [highlightLines, setHighlightLines] = useState<HighlightLine[]>([]);
  const [renderedClips, setRenderedClips] = useState<RenderedClipLine[]>([]);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>(DEFAULT_PIPELINE_STEPS);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollingFailuresRef = useRef(0);
  const resubscribeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resubscribeActionRef = useRef<(videoId: string) => void>(() => undefined);
  const latestOverallRef = useRef<PipelineSnapshot["overall"]>("idle");
  const [isConnectionDegraded, setIsConnectionDegraded] = useState(false);
  const [connectionMode, setConnectionMode] = useState<"sse" | "polling">("sse");

  const applyPipelineSnapshot = useCallback((snapshot: PipelineSnapshot) => {
    latestOverallRef.current = snapshot.overall;
    if (snapshot.overall === "success" || snapshot.overall === "failed") {
      setConnectionMode("sse");
      setIsConnectionDegraded(false);
      pollingFailuresRef.current = 0;
    }
    setPipelineSteps((prev) =>
      prev.map((step) => {
        const incoming = snapshot.steps.find((incomingStep) => incomingStep.id === step.id);
        if (!incoming) {
          return step;
        }
        return {
          ...step,
          status: incoming.status,
          detail: incoming.detail,
        };
      })
    );
  }, []);

  const stopPolling = useCallback(() => {
    if (!pollingTimerRef.current) {
      return;
    }
    clearTimeout(pollingTimerRef.current);
    pollingTimerRef.current = null;
  }, []);

  const stopResubscribe = useCallback(() => {
    if (!resubscribeTimerRef.current) {
      return;
    }
    clearTimeout(resubscribeTimerRef.current);
    resubscribeTimerRef.current = null;
  }, []);

  const stopSse = useCallback(() => {
    if (!sseRef.current) {
      return;
    }
    sseRef.current.close();
    sseRef.current = null;
  }, []);

  const fetchPipelineSnapshot = useCallback(async (videoId: string) => {
    const response = await fetch(`/api/videos/status?videoId=${encodeURIComponent(videoId)}`, {
      method: "GET",
      cache: "no-store",
    });

    const result = (await response.json()) as
      | (PipelineStatusResult & { message?: string })
      | { ok: false; message?: string };

    if (!response.ok || !result.ok || !("pipeline" in result)) {
      throw new Error(("message" in result && result.message) || "Gagal memuat status pipeline");
    }

    applyPipelineSnapshot(result.pipeline);
    return result;
  }, [applyPipelineSnapshot]);

  const scheduleResubscribe = useCallback(
    (videoId: string, delayMs: number) => {
      if (latestOverallRef.current === "success" || latestOverallRef.current === "failed") {
        return;
      }
      stopResubscribe();
      resubscribeTimerRef.current = setTimeout(() => {
        resubscribeTimerRef.current = null;
        resubscribeActionRef.current(videoId);
      }, delayMs);
    },
    [stopResubscribe]
  );

  const pollPipelineWithBackoff = useCallback(
    async (videoId: string, delayMs = 3000) => {
      stopPolling();
      if (latestOverallRef.current === "success" || latestOverallRef.current === "failed") {
        return;
      }
      pollingTimerRef.current = setTimeout(async () => {
        pollingTimerRef.current = null;
        try {
          const status = await fetchPipelineSnapshot(videoId);
          pollingFailuresRef.current = 0;
          setIsConnectionDegraded(false);
          if (status.pipeline.overall === "success" || status.pipeline.overall === "failed") {
            stopPolling();
            stopResubscribe();
            return;
          }
          await pollPipelineWithBackoff(videoId, 3000);
        } catch {
          const failures = pollingFailuresRef.current + 1;
          pollingFailuresRef.current = failures;
          if (failures >= 3) {
            setIsConnectionDegraded(true);
          }
          const nextDelay = Math.min(15000, 3000 * 2 ** Math.min(failures, 3));
          await pollPipelineWithBackoff(videoId, nextDelay);
        }
      }, delayMs);
    },
    [fetchPipelineSnapshot, stopPolling, stopResubscribe]
  );

  const enterPollingFallback = useCallback(
    (videoId: string) => {
      stopSse();
      setConnectionMode("polling");
      void pollPipelineWithBackoff(videoId, 0);
      scheduleResubscribe(videoId, 12000);
    },
    [pollPipelineWithBackoff, scheduleResubscribe, stopSse]
  );

  const subscribePipelineStream = useCallback(
    (videoId: string) => {
      if (latestOverallRef.current === "success" || latestOverallRef.current === "failed") {
        stopSse();
        stopPolling();
        stopResubscribe();
        return;
      }
      stopSse();

      const stream = new EventSource(`/api/videos/status/stream?videoId=${encodeURIComponent(videoId)}`);
      sseRef.current = stream;
      setConnectionMode("sse");
      setIsConnectionDegraded(false);
      pollingFailuresRef.current = 0;
      stopPolling();

      const onStatusPayload = (payload: unknown) => {
        if (!payload || typeof payload !== "object" || !("pipeline" in payload)) {
          return;
        }
        const pipeline = (payload as { pipeline?: PipelineSnapshot }).pipeline;
        if (!pipeline) {
          return;
        }
        applyPipelineSnapshot(pipeline);
        if (pipeline.overall === "success" || pipeline.overall === "failed") {
          stopPolling();
          stopSse();
          stopResubscribe();
        }
      };

      stream.addEventListener("snapshot", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
          onStatusPayload(payload);
        } catch {
          enterPollingFallback(videoId);
        }
      });

      stream.addEventListener("status_update", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as unknown;
          onStatusPayload(payload);
        } catch {
          enterPollingFallback(videoId);
        }
      });

      stream.onerror = () => {
        enterPollingFallback(videoId);
      };
    },
    [applyPipelineSnapshot, enterPollingFallback, stopPolling, stopResubscribe, stopSse]
  );

  useEffect(() => {
    resubscribeActionRef.current = (videoId: string) => {
      subscribePipelineStream(videoId);
    };
  }, [subscribePipelineStream]);

  useEffect(() => {
    if (!activeVideoId) {
      latestOverallRef.current = "idle";
      setConnectionMode("sse");
      setIsConnectionDegraded(false);
      pollingFailuresRef.current = 0;
      stopSse();
      stopPolling();
      stopResubscribe();
      return;
    }

    latestOverallRef.current = "running";
    setConnectionMode("sse");
    setIsConnectionDegraded(false);
    pollingFailuresRef.current = 0;

    void fetchPipelineSnapshot(activeVideoId)
      .then((status) => {
        if (status.pipeline.overall === "success" || status.pipeline.overall === "failed") {
          stopPolling();
          stopResubscribe();
          return;
        }
        subscribePipelineStream(activeVideoId);
      })
      .catch(() => {
        enterPollingFallback(activeVideoId);
      });

    return () => {
      stopSse();
      stopPolling();
      stopResubscribe();
    };
  }, [activeVideoId, enterPollingFallback, fetchPipelineSnapshot, stopPolling, stopResubscribe, stopSse, subscribePipelineStream]);

  function markStep(id: PipelineStepId, status: PipelineStepStatus, detail: string) {
    setPipelineSteps((prev) =>
      prev.map((step) => {
        if (step.id !== id) {
          return step;
        }
        return { ...step, status, detail };
      })
    );
  }

  async function handleProduce() {
    let redirectVideoId: string | null = null;
    const useUpload = Boolean(selectedFile);
    const normalizedWatermarkText = watermarkText.trim().slice(0, 120);
    const podcastModeEnabled = podcastTwoSpeakerMode;

    if (!useUpload && !url.trim()) {
      setIsError(true);
      setMessage("Masukkan link YouTube atau pilih file video dulu.");
      return;
    }

    setProcessing(true);
    setIsError(false);
    setMessage(null);
    setTranscriptLines([]);
    setHighlightLines([]);
    setRenderedClips([]);
    setPipelineSteps(DEFAULT_PIPELINE_STEPS);
    setActiveVideoId(null);

    let activeStep: PipelineStepId = "download";

    try {
      let response: Response;

      if (useUpload) {
        setMessage("Uploading source video...");
        markStep("download", "running", "Mengunggah source video...");

        const formData = new FormData();
        formData.append("file", selectedFile as File);
        formData.append("renderLayout", renderLayoutMode);
        formData.append("podcastTwoSpeakerMode", podcastModeEnabled ? "true" : "false");
         formData.append("clipDurationPreset", clipDurationPreset);
         formData.append("clipCountTarget", String(clipCountTarget));
         formData.append("emotionContext", emotionContext);

        if (normalizedWatermarkText) {
          formData.append("watermarkText", normalizedWatermarkText);
        }
        if (watermarkLogoFile) {
          formData.append("watermarkLogo", watermarkLogoFile);
        }

        response = await fetch("/api/videos/upload", {
          method: "POST",
          body: formData,
        });
      } else {
        setMessage("Downloading video from YouTube...");
        markStep("download", "running", "Mengunduh video dari YouTube...");

        const formData = new FormData();
        formData.append("url", url.trim());
        formData.append("renderLayout", renderLayoutMode);
        formData.append("podcastTwoSpeakerMode", podcastModeEnabled ? "true" : "false");
         formData.append("clipDurationPreset", clipDurationPreset);
         formData.append("clipCountTarget", String(clipCountTarget));
         formData.append("emotionContext", emotionContext);

        if (normalizedWatermarkText) {
          formData.append("watermarkText", normalizedWatermarkText);
        }
        if (watermarkLogoFile) {
          formData.append("watermarkLogo", watermarkLogoFile);
        }

        response = await fetch("/api/videos/import-youtube", {
          method: "POST",
          body: formData,
        });
      }

      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
        deduplicated?: boolean;
        video?: { id: string };
      };

      if (!response.ok || !result.ok) {
        markStep("download", "error", result.message ?? "Gagal ingest video.");
        setIsError(true);
        setMessage(result.message ?? "Gagal memproses sumber video.");
        return;
      }

      markStep(
        "download",
        "done",
        result.deduplicated
          ? "Video sudah ada (dedup), lanjut proses."
          : useUpload
            ? "Upload selesai."
            : "Download selesai."
      );

      const importedVideoId = result.video?.id;
      if (importedVideoId) {
        setActiveVideoId(importedVideoId);
      }
      if (!importedVideoId) {
        markStep("download", "error", "videoId tidak ditemukan setelah download.");
        setIsError(true);
        setMessage("Video berhasil diproses, tapi videoId tidak ditemukan untuk proses transkripsi.");
        return;
      }

      activeStep = "transcribe";
      setMessage("Extracting audio and transcribing with Groq Whisper...");
      markStep("transcribe", "running", "Ekstrak audio dan transkripsi sedang berjalan...");

      const transcribeResponse = await fetch("/api/videos/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: importedVideoId }),
      });

      const transcribeResult = (await transcribeResponse.json()) as {
        ok: boolean;
        deduplicated?: boolean;
        jobId?: string;
        message?: string;
        transcript?: {
          segmentsCount?: number;
          textPreview?: string;
          segments?: TranscriptLine[];
        };
      };

      if (!transcribeResponse.ok || !transcribeResult.ok) {
        markStep("transcribe", "error", transcribeResult.message ?? "Transkripsi gagal.");
        setIsError(true);
        setMessage(transcribeResult.message ?? "Video terunduh, tapi transkripsi gagal.");
        return;
      }

      if (transcribeResult.deduplicated) {
        markStep("transcribe", "running", "Transkripsi sedang berjalan di sesi/device lain...");
        setIsError(false);
        setMessage(
          transcribeResult.message ??
            "Transkripsi sudah berjalan di sesi lain. Menunggu update sinkron dari server..."
        );
        return;
      }

      markStep(
        "transcribe",
        "done",
        transcribeResult.transcript?.segmentsCount
          ? `Selesai (${transcribeResult.transcript.segmentsCount} segmen).`
          : "Transkripsi selesai."
      );

      activeStep = "highlight";
      setMessage("Selecting best engagement segments with Groq GPT-OSS-120B...");
      markStep("highlight", "running", "AI sedang memilih kandidat highlight...");

      const highlightResponse = await fetch("/api/videos/highlights/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoId: importedVideoId,
          durationPreset: clipDurationPreset,
          clipCountTarget,
          emotionContext,
        }),
      });

      const highlightResult = (await highlightResponse.json()) as {
        ok: boolean;
        deduplicated?: boolean;
        jobId?: string;
        message?: string;
        highlights?: {
          model?: string;
          candidates?: Array<{
            startMs: number;
            endMs: number;
            scoreTotal: number;
            reason: string;
            topic?: string;
          }>;
        };
      };

      if (!highlightResponse.ok || !highlightResult.ok) {
        markStep("highlight", "error", highlightResult.message ?? "Seleksi highlight gagal.");
        setIsError(true);
        setMessage(highlightResult.message ?? "Transkripsi selesai, tapi seleksi highlight AI gagal.");
        setTranscriptLines(transcribeResult.transcript?.segments || []);
        return;
      }

      if (highlightResult.deduplicated) {
        markStep("highlight", "running", "Seleksi highlight sedang berjalan di sesi/device lain...");
        setIsError(false);
        setMessage(
          highlightResult.message ??
            "Seleksi highlight sudah berjalan di sesi lain. Menunggu update sinkron dari server..."
        );
        return;
      }

      markStep(
        "highlight",
        "done",
        `${highlightResult.highlights?.candidates?.length ?? 0} kandidat dipilih AI.`
      );

      activeStep = "render";
      setMessage("Cropping to portrait with face detection and rendering clips...");
      markStep("render", "running", "Crop portrait, burn subtitle, render clip & thumbnail...");

      const renderResponse = await fetch("/api/videos/render-clips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: importedVideoId }),
      });

      const renderResult = (await renderResponse.json()) as {
        ok: boolean;
        deduplicated?: boolean;
        jobId?: string;
        message?: string;
        render?: {
          faceFound?: boolean;
          clipCount?: number;
          clips?: RenderedClipLine[];
        };
      };

      if (!renderResponse.ok || !renderResult.ok) {
        markStep("render", "error", renderResult.message ?? "Render clips gagal.");
        setIsError(true);
        setMessage(renderResult.message ?? "Seleksi highlight selesai, tapi render clips gagal.");
        setTranscriptLines(transcribeResult.transcript?.segments || []);
        setHighlightLines(
          (highlightResult.highlights?.candidates || []).map((candidate) => ({
            startMs: candidate.startMs,
            endMs: candidate.endMs,
            scoreTotal: candidate.scoreTotal,
            reason: candidate.reason,
            topic: candidate.topic,
          }))
        );
        return;
      }

      if (renderResult.deduplicated) {
        markStep("render", "running", "Render clips sedang berjalan di sesi/device lain...");
        setIsError(false);
        setMessage(
          renderResult.message ??
            "Render clips sudah berjalan di sesi lain. Menunggu update sinkron dari server..."
        );
        return;
      }

      markStep(
        "render",
        "done",
        `${renderResult.render?.clipCount ?? 0} clips selesai dirender.`
      );

      setIsError(false);
      const sourceMessage = result.deduplicated
        ? "Video sudah ada (dedup)."
        : useUpload
          ? "Video berhasil diunggah."
          : "Video berhasil diunduh.";
      const transcriptInfo = transcribeResult.transcript?.segmentsCount
        ? ` ${transcribeResult.transcript.segmentsCount} segmen transcript tersimpan.`
        : " Transcript selesai disimpan.";

      const highlightCount = highlightResult.highlights?.candidates?.length ?? 0;
      const clipCount = renderResult.render?.clipCount ?? 0;
      const faceInfo = renderResult.render?.faceFound ? " Face detected." : " Face fallback center crop.";

      setMessage(
        `${sourceMessage}${transcriptInfo} ${highlightCount} kandidat highlight dipilih AI. ${clipCount} clips selesai dirender.${faceInfo}`
      );
      setTranscriptLines(transcribeResult.transcript?.segments || []);
      setHighlightLines(
        (highlightResult.highlights?.candidates || []).map((candidate) => ({
          startMs: candidate.startMs,
          endMs: candidate.endMs,
          scoreTotal: candidate.scoreTotal,
          reason: candidate.reason,
          topic: candidate.topic,
        }))
      );
      setRenderedClips(renderResult.render?.clips || []);
      setUrl("");
      setSelectedFile(null);
      setRenderLayoutMode("standard");
      setPodcastTwoSpeakerMode(false);
      setWatermarkText("");
      setWatermarkLogoFile(null);
      setClipDurationPreset("under_1_minute");
      setClipCountTarget(DEFAULT_CLIP_COUNT_TARGET);
      setEmotionContext(DEFAULT_EMOTION_CONTEXT);
      redirectVideoId = importedVideoId;
    } catch {
      markStep(activeStep, "error", "Terjadi kesalahan jaringan saat memproses step ini.");
      setIsError(true);
      setMessage("Terjadi kesalahan jaringan saat memproses video.");
    } finally {
      setProcessing(false);

      if (redirectVideoId) {
        router.push(`/library?videoId=${encodeURIComponent(redirectVideoId)}`);
      }
    }
  }

  const showPipelineProgress =
    processing || pipelineSteps.some((step) => step.status !== "pending");

  return (
    <div className="relative z-10 w-full px-4 lg:px-8 py-8 sm:py-10 space-y-6">
      <div className="border border-white/10 bg-[#171717] p-4 sm:p-6 space-y-5">
        <HeroSection />
        <VideoSourceInput
          value={url}
          onChange={setUrl}
          onFileSelect={setSelectedFile}
          selectedFileName={selectedFile?.name || null}
          renderLayoutMode={renderLayoutMode}
          onRenderLayoutModeChange={setRenderLayoutMode}
          podcastTwoSpeakerMode={podcastTwoSpeakerMode}
          onPodcastTwoSpeakerModeChange={setPodcastTwoSpeakerMode}
          watermarkText={watermarkText}
          onWatermarkTextChange={setWatermarkText}
          onWatermarkLogoSelect={setWatermarkLogoFile}
          selectedWatermarkLogoName={watermarkLogoFile?.name || null}
          clipDurationPreset={clipDurationPreset}
          onClipDurationPresetChange={setClipDurationPreset}
          clipCountTarget={clipCountTarget}
          onClipCountTargetChange={setClipCountTarget}
          emotionContext={emotionContext}
          onEmotionContextChange={setEmotionContext}
          disabled={processing}
        />
        <ProduceClipsCta onClick={handleProduce} disabled={processing} isProcessing={processing} />
        {message && (
          <p className={`text-center text-sm ${isError ? "text-white/70" : "text-white/85"}`}>{message}</p>
        )}
        {(showPipelineProgress || isConnectionDegraded) && (
          <p className="text-center text-xs text-white/60">
            {isConnectionDegraded
              ? "Koneksi realtime tidak stabil, sinkronisasi status beralih ke polling sementara."
              : connectionMode === "sse"
                ? "Sinkronisasi status realtime aktif."
                : "Sinkronisasi status via polling."}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        <div className="xl:col-span-8 space-y-6">
          {transcriptLines.length > 0 && (
            <div className="border border-white/10 bg-[#171717] p-4 sm:p-5 space-y-3">
              <h3 className="text-[10px] font-semibold tracking-[0.2em] text-white/70 uppercase">
                Transcript Preview
              </h3>
              <div className="space-y-2 max-h-56 overflow-auto pr-1">
                {transcriptLines.map((line, index) => (
                  <div key={`${line.startMs}-${line.endMs}-${index}`} className="text-sm text-white/80">
                    <span className="inline-block min-w-28 text-white font-semibold">
                      {formatMs(line.startMs)} - {formatMs(line.endMs)}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {highlightLines.length > 0 && (
            <div className="border border-white/10 bg-[#171717] p-4 sm:p-5 space-y-3">
              <h3 className="text-[10px] font-semibold tracking-[0.2em] text-white/70 uppercase">
                AI Highlight Candidates
              </h3>
              <div className="space-y-3 max-h-72 overflow-auto pr-1">
                {highlightLines.map((line, index) => (
                  <div key={`${line.startMs}-${line.endMs}-${index}`} className="text-sm text-white/80 space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="inline-block min-w-28 text-white font-semibold">
                        {formatMs(line.startMs)} - {formatMs(line.endMs)}
                      </span>
                      <span className="text-white/70 font-semibold">Score: {line.scoreTotal.toFixed(2)}</span>
                      {line.topic && <span className="text-white/55 uppercase text-xs">{line.topic}</span>}
                    </div>
                    <p className="text-white/70">{line.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="xl:col-span-4 space-y-6">
          {showPipelineProgress && (
            <div className="border border-white/10 bg-[#171717] p-4 sm:p-5 space-y-3">
              <h3 className="text-[10px] font-semibold tracking-[0.2em] text-white/70 uppercase">Pipeline Status</h3>
              <div className="space-y-2">
                {pipelineSteps.map((step) => (
                  <div
                    key={step.id}
                    className="flex items-center justify-between gap-3 border border-white/10 bg-black px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-2.5 w-2.5 rounded-full ${getStepDotClass(step.status)}`} />
                      <span className={`text-sm font-semibold ${getStepLabelClass(step.status)}`}>{step.label}</span>
                    </div>
                    <span className="text-xs text-white/60 text-right">{step.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {renderedClips.length > 0 && (
            <div className="border border-white/10 bg-[#171717] p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[10px] font-semibold tracking-[0.2em] text-white/70 uppercase">
                  Rendered Clips
                </h3>
                <a
                  href="/library"
                  className="text-xs font-bold uppercase tracking-wide text-white hover:text-white/80"
                >
                  Open Library
                </a>
              </div>
              <div className="space-y-2 max-h-72 overflow-auto pr-1">
                {renderedClips.map((clip) => (
                  <div key={clip.id} className="text-sm text-white/80">
                    <span className="inline-block min-w-28 text-white font-semibold">
                      {formatMs(clip.startMs)} - {formatMs(clip.endMs)}
                    </span>
                    <span className="text-white/65">{clip.outputFileKey}</span>
                    {clip.subtitleMode === "hard" && (
                      <span className="ml-2 text-white/70 text-xs uppercase">burn-in subtitle</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="pb-2">
            <WorkflowChips />
          </div>
        </div>
      </div>
    </div>
  );
}
