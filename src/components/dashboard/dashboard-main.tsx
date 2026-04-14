"use client";

import { useState } from "react";

import { BentoStatsCards } from "@/components/dashboard/bento-stats-cards";
import { HeroSection } from "@/components/dashboard/hero-section";
import { ProduceClipsCta } from "@/components/dashboard/produce-clips-cta";
import { VideoSourceInput } from "@/components/dashboard/video-source-input";
import { WorkflowChips } from "@/components/dashboard/workflow-chips";

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

const DEFAULT_PIPELINE_STEPS: PipelineStep[] = [
  { id: "download", label: "Ingest Video", status: "pending", detail: "Menunggu proses" },
  { id: "transcribe", label: "Transcribe", status: "pending", detail: "Menunggu proses" },
  { id: "highlight", label: "AI Highlights", status: "pending", detail: "Menunggu proses" },
  { id: "render", label: "Crop + Render", status: "pending", detail: "Menunggu proses" },
];

function getStepDotClass(status: PipelineStepStatus): string {
  if (status === "done") {
    return "bg-[#22c55e]";
  }
  if (status === "running") {
    return "bg-[#85adff] animate-pulse";
  }
  if (status === "error") {
    return "bg-[#ff716c]";
  }
  return "bg-white/20";
}

function getStepLabelClass(status: PipelineStepStatus): string {
  if (status === "done") {
    return "text-[#22c55e]";
  }
  if (status === "running") {
    return "text-[#85adff]";
  }
  if (status === "error") {
    return "text-[#ff716c]";
  }
  return "text-[#c3c0bf]";
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
  const [url, setUrl] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [processing, setProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [highlightLines, setHighlightLines] = useState<HighlightLine[]>([]);
  const [renderedClips, setRenderedClips] = useState<RenderedClipLine[]>([]);
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>(DEFAULT_PIPELINE_STEPS);

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
    const useUpload = Boolean(selectedFile);

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

    let activeStep: PipelineStepId = "download";

    try {
      let response: Response;

      if (useUpload) {
        setMessage("Uploading source video...");
        markStep("download", "running", "Mengunggah source video...");

        const formData = new FormData();
        formData.append("file", selectedFile as File);

        response = await fetch("/api/videos/upload", {
          method: "POST",
          body: formData,
        });
      } else {
        setMessage("Downloading video from YouTube...");
        markStep("download", "running", "Mengunduh video dari YouTube...");

        response = await fetch("/api/videos/import-youtube", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
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
        body: JSON.stringify({ videoId: importedVideoId }),
      });

      const highlightResult = (await highlightResponse.json()) as {
        ok: boolean;
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
    } catch {
      markStep(activeStep, "error", "Terjadi kesalahan jaringan saat memproses step ini.");
      setIsError(true);
      setMessage("Terjadi kesalahan jaringan saat memproses video.");
    } finally {
      setProcessing(false);
    }
  }

  const showPipelineProgress =
    processing || pipelineSteps.some((step) => step.status !== "pending");

  return (
    <>
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[#85adff]/5 rounded-full blur-[120px]" />
      </div>

      <div className="relative z-10 h-full flex flex-col items-center justify-center px-4 max-w-5xl mx-auto">
        <HeroSection />

        <div className="w-full max-w-3xl space-y-8">
          <VideoSourceInput
            value={url}
            onChange={setUrl}
            onFileSelect={setSelectedFile}
            selectedFileName={selectedFile?.name || null}
            disabled={processing}
          />
          <ProduceClipsCta onClick={handleProduce} disabled={processing} isProcessing={processing} />

          {message && (
            <p className={`text-center text-sm ${isError ? "text-[#ff716c]" : "text-[#85adff]"}`}>{message}</p>
          )}

          {showPipelineProgress && (
            <div className="rounded-xl border border-white/10 bg-[#121212]/85 p-4 sm:p-5 space-y-3">
              <h3 className="text-sm font-bold tracking-wide text-white uppercase">Pipeline Status</h3>
              <div className="space-y-2">
                {pipelineSteps.map((step) => (
                  <div
                    key={step.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-white/5 bg-black/20 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`h-2.5 w-2.5 rounded-full ${getStepDotClass(step.status)}`} />
                      <span className={`text-sm font-semibold ${getStepLabelClass(step.status)}`}>
                        {step.label}
                      </span>
                    </div>
                    <span className="text-xs text-[#b8b5b4] text-right">{step.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {transcriptLines.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-[#131313]/80 p-4 sm:p-5 space-y-3">
              <h3 className="text-sm font-bold tracking-wide text-white uppercase">Transcript Preview</h3>
              <div className="space-y-2 max-h-56 overflow-auto pr-1">
                {transcriptLines.map((line, index) => (
                  <div key={`${line.startMs}-${line.endMs}-${index}`} className="text-sm text-[#d2d0cf]">
                    <span className="inline-block min-w-28 text-[#85adff] font-semibold">
                      {formatMs(line.startMs)} - {formatMs(line.endMs)}
                    </span>
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {highlightLines.length > 0 && (
            <div className="rounded-xl border border-[#85adff]/30 bg-[#0f1726]/60 p-4 sm:p-5 space-y-3">
              <h3 className="text-sm font-bold tracking-wide text-white uppercase">AI Highlight Candidates</h3>
              <div className="space-y-3 max-h-64 overflow-auto pr-1">
                {highlightLines.map((line, index) => (
                  <div key={`${line.startMs}-${line.endMs}-${index}`} className="text-sm text-[#d2d0cf] space-y-1">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="inline-block min-w-28 text-[#85adff] font-semibold">
                        {formatMs(line.startMs)} - {formatMs(line.endMs)}
                      </span>
                      <span className="text-[#ffd16c] font-semibold">Score: {line.scoreTotal.toFixed(2)}</span>
                      {line.topic && <span className="text-[#adaaaa] uppercase text-xs">{line.topic}</span>}
                    </div>
                    <p className="text-[#c3c0bf]">{line.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {renderedClips.length > 0 && (
            <div className="rounded-xl border border-[#22c55e]/30 bg-[#0d1f16]/60 p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-bold tracking-wide text-white uppercase">Rendered Clips</h3>
                <a
                  href="/library"
                  className="text-xs font-bold uppercase tracking-wide text-[#85adff] hover:text-[#a8c4ff]"
                >
                  Open Library
                </a>
              </div>
              <div className="space-y-2 max-h-56 overflow-auto pr-1">
                {renderedClips.map((clip) => (
                  <div key={clip.id} className="text-sm text-[#d2d0cf]">
                    <span className="inline-block min-w-28 text-[#22c55e] font-semibold">
                      {formatMs(clip.startMs)} - {formatMs(clip.endMs)}
                    </span>
                    <span className="text-[#c3c0bf]">{clip.outputFileKey}</span>
                    {clip.subtitleMode === "hard" && (
                      <span className="ml-2 text-[#85adff] text-xs uppercase">burn-in subtitle</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <WorkflowChips />
      </div>

      <BentoStatsCards />
    </>
  );
}
