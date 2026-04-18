"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type LibraryFolder = {
  videoId: string;
  clipCount: number;
  latestClipAt: string | null;
  thumbnailKey: string | null;
  video: {
    id: string;
    sourceTitle: string | null;
    sourcePlatform: string | null;
    sourceUrl: string | null;
  };
};

type LibraryClip = {
  id: string;
  startMs: number;
  endMs: number;
  outputFileKey: string;
  thumbnailKey: string | null;
  subtitleMode: "none" | "hard";
  highlight: {
    scorePercent: number | null;
    reasonJson: unknown;
    matchedEmotionContext?: string | null;
    emotionFitScore?: number | null;
    emotionFitReason?: string | null;
    emotionFallback?: boolean | null;
  } | null;
  video: {
    id: string;
    sourceTitle: string | null;
    sourcePlatform: string | null;
    sourceUrl: string | null;
  };
};

type LibraryMainProps = {
  folders: LibraryFolder[];
};

const INITIAL_CLIPS_BATCH = 12;

type ClipReviewView = {
  recommendedTitle: string | null;
  overallScore: number | null;
  whyThisWorks: string | null;
  improvementTip: string | null;
  scoreHook: number | null;
  scoreValue: number | null;
  matchedEmotionContext: string | null;
  emotionFitScore: number | null;
  emotionFitReason: string | null;
  emotionFallback: boolean;
};

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatDateLabel(rawIso: string | null): string {
  if (!rawIso) {
    return "-";
  }

  const date = new Date(rawIso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function buildFileUrl(key: string, download = false): string {
  const params = new URLSearchParams({ key });
  if (download) {
    params.set("download", "1");
  }
  return `/api/files?${params.toString()}`;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asScore(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return null;
  }
  if (raw <= 1) {
    return Math.round(Math.max(0, Math.min(1, raw)) * 100);
  }
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function extractClipReview(clip: LibraryClip): ClipReviewView {
  const reasonRoot = asObject(clip.highlight?.reasonJson);
  const clipReview = asObject(reasonRoot?.clipReview);
  const reasonFallback = clip.highlight?.emotionFallback ?? reasonRoot?.emotionFallback;

  return {
    recommendedTitle: asString(clipReview?.recommendedTitle),
    overallScore: asScore(clipReview?.overallScore) ?? clip.highlight?.scorePercent ?? null,
    whyThisWorks: asString(clipReview?.whyThisWorks) || asString(reasonRoot?.reason),
    improvementTip: asString(clipReview?.improvementTip),
    scoreHook: asScore(clipReview?.hookScore),
    scoreValue: asScore(clipReview?.valueScore),
    matchedEmotionContext:
      asString(clipReview?.matchedEmotionContext) ||
      asString(reasonRoot?.matchedEmotionContext) ||
      clip.highlight?.matchedEmotionContext ||
      null,
    emotionFitScore:
      asScore(clipReview?.emotionFitScore) ??
      asScore(reasonRoot?.emotionFitScore) ??
      asScore(clip.highlight?.emotionFitScore) ??
      null,
    emotionFitReason:
      asString(clipReview?.emotionFitReason) ||
      asString(reasonRoot?.emotionFitReason) ||
      clip.highlight?.emotionFitReason ||
      null,
    emotionFallback: typeof reasonFallback === "boolean" ? reasonFallback : false,
  };
}

function FolderCard({
  folder,
  isActive,
  onSelect,
}: {
  folder: LibraryFolder;
  isActive: boolean;
  onSelect: (videoId: string) => void;
}) {
  const title = folder.video.sourceTitle?.trim() || "Untitled Source";
  const thumbnailUrl = folder.thumbnailKey ? buildFileUrl(folder.thumbnailKey) : null;

  return (
    <button
      type="button"
      onClick={() => onSelect(folder.videoId)}
      className={`w-full text-left rounded-xl border overflow-hidden transition-all ${
        isActive
          ? "border-[#85adff]/80 bg-[#101523] shadow-[0_0_0_1px_rgba(133,173,255,0.45)]"
          : "border-white/10 bg-[#151515]/85 hover:border-white/25"
      }`}
    >
      <div className="relative h-40 bg-black/70">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={`Cover ${title}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[#777] text-sm">
            No thumbnail
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
      </div>

      <div className="p-4 space-y-2">
        <h2 className="text-sm font-bold text-white line-clamp-2">{title}</h2>
        <p className="text-xs text-[#b8b4b2]">
          {folder.video.sourcePlatform || "unknown"} • {folder.clipCount} clip
        </p>
        <p className="text-[11px] text-[#8f8b89]">Update terakhir: {formatDateLabel(folder.latestClipAt)}</p>
      </div>
    </button>
  );
}

function LibraryClipCard({ clip }: { clip: LibraryClip }) {
  const containerRef = useRef<HTMLElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const title = clip.video.sourceTitle?.trim() || "Untitled Source";
  const review = useMemo(() => extractClipReview(clip), [clip]);
  const previewUrl = useMemo(() => buildFileUrl(clip.outputFileKey), [clip.outputFileKey]);
  const downloadUrl = useMemo(() => buildFileUrl(clip.outputFileKey, true), [clip.outputFileKey]);
  const thumbnailUrl = useMemo(
    () => (clip.thumbnailKey ? buildFileUrl(clip.thumbnailKey) : null),
    [clip.thumbnailKey]
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isVisible) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (first?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      {
        rootMargin: "280px 0px",
        threshold: 0.1,
      }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [isVisible]);

  return (
    <article
      ref={containerRef}
      className="rounded-xl border border-white/10 bg-[#151515]/90 overflow-hidden shadow-[0_10px_40px_-20px_rgba(0,0,0,0.8)]"
    >
      <div className="relative aspect-[9/16] bg-black">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={`Thumbnail ${title}`}
            className="absolute inset-0 w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[#777] text-sm">
            No thumbnail
          </div>
        )}

        {isVisible && (
          <video
            className="absolute inset-0 w-full h-full object-contain"
            controls
            preload="none"
            playsInline
            src={previewUrl}
          />
        )}
      </div>

      <div className="p-4 space-y-3">
        <div>
          <h2 className="text-sm font-bold text-white line-clamp-2">
            {review.recommendedTitle || title}
          </h2>
          {review.recommendedTitle && (
            <p className="mt-1 text-[11px] text-[#b0adac] line-clamp-1">Source: {title}</p>
          )}
          <p className="mt-1 text-xs text-[#9f9c9b]">
            {formatMs(clip.startMs)} - {formatMs(clip.endMs)}
            {clip.video.sourcePlatform ? ` • ${clip.video.sourcePlatform}` : ""}
          </p>
        </div>

        {review.overallScore !== null && (
          <div className="rounded-lg border border-[#85adff]/30 bg-[#0f131c] p-3 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wide text-[#85adff] font-semibold">
                AI Score
              </span>
              <span className="text-sm font-black text-[#9dc0ff]">{review.overallScore}/100</span>
            </div>
            {(review.scoreHook !== null || review.scoreValue !== null || review.emotionFitScore !== null) && (
              <p className="text-[11px] text-[#b8c7ea]">
                Hook {review.scoreHook ?? "-"} • Value {review.scoreValue ?? "-"}
                {review.emotionFitScore !== null ? ` • Emotion ${review.emotionFitScore}` : ""}
              </p>
            )}
            {(review.matchedEmotionContext || review.emotionFitReason) && (
              <p className="text-[11px] text-[#d7def5] line-clamp-2">
                {review.matchedEmotionContext ? `Emotion: ${review.matchedEmotionContext}` : "Emotion fit"}
                {review.emotionFallback ? " • fallback" : ""}
                {review.emotionFitReason ? ` • ${review.emotionFitReason}` : ""}
              </p>
            )}
            {review.whyThisWorks && (
              <p className="text-[11px] text-[#c7d7ff] line-clamp-2">{review.whyThisWorks}</p>
            )}
            {review.improvementTip && (
              <p className="text-[11px] text-[#9fa9bf] line-clamp-2">Tip: {review.improvementTip}</p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[#85adff] font-semibold">
            {clip.subtitleMode === "hard" ? "Subtitle Burn-in" : "No Subtitle"}
          </span>
          <a
            href={downloadUrl}
            className="inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-bold bg-[#85adff]/20 text-[#85adff] hover:bg-[#85adff]/30 transition-colors"
          >
            Download
          </a>
        </div>
      </div>
    </article>
  );
}

export function LibraryMain({ folders }: LibraryMainProps) {
  const searchParams = useSearchParams();
  const requestedVideoId = searchParams.get("videoId");

  const [selectedVideoId, setSelectedVideoId] = useState<string | null>(null);
  const [videoClips, setVideoClips] = useState<Record<string, LibraryClip[]>>({});
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  const [errorMap, setErrorMap] = useState<Record<string, string | null>>({});
  const [hasMoreMap, setHasMoreMap] = useState<Record<string, boolean>>({});
  const [cursorMap, setCursorMap] = useState<Record<string, string | null>>({});
  const [initializedMap, setInitializedMap] = useState<Record<string, boolean>>({});
  const clipSentinelRef = useRef<HTMLDivElement | null>(null);

  const selectedFolder = useMemo(() => {
    if (!selectedVideoId) {
      return null;
    }
    return folders.find((folder) => folder.videoId === selectedVideoId) || null;
  }, [folders, selectedVideoId]);

  const selectedClips = useMemo(() => {
    if (!selectedVideoId) {
      return [];
    }
    return videoClips[selectedVideoId] || [];
  }, [selectedVideoId, videoClips]);

  async function fetchFolderClips(videoId: string, append: boolean) {
    if (loadingMap[videoId]) {
      return;
    }

    setLoadingMap((prev) => ({ ...prev, [videoId]: true }));
    setErrorMap((prev) => ({ ...prev, [videoId]: null }));

    try {
      const params = new URLSearchParams({
        videoId,
        limit: String(INITIAL_CLIPS_BATCH),
      });

      if (append && cursorMap[videoId]) {
        params.set("cursor", cursorMap[videoId] || "");
      }

      const response = await fetch(`/api/library/clips?${params.toString()}`, {
        method: "GET",
      });

      const result = (await response.json()) as {
        ok: boolean;
        message?: string;
        clips?: LibraryClip[];
        pageInfo?: {
          hasMore?: boolean;
          nextCursor?: string | null;
        };
      };

      if (!response.ok || !result.ok) {
        throw new Error(result.message || "Gagal memuat clips pada folder ini");
      }

      const nextItems = result.clips || [];

      setVideoClips((prev) => ({
        ...prev,
        [videoId]: append ? [...(prev[videoId] || []), ...nextItems] : nextItems,
      }));
      setHasMoreMap((prev) => ({ ...prev, [videoId]: Boolean(result.pageInfo?.hasMore) }));
      setCursorMap((prev) => ({ ...prev, [videoId]: result.pageInfo?.nextCursor || null }));
      setInitializedMap((prev) => ({ ...prev, [videoId]: true }));
    } catch (error) {
      setErrorMap((prev) => ({
        ...prev,
        [videoId]: error instanceof Error ? error.message : "Gagal memuat clips",
      }));
    } finally {
      setLoadingMap((prev) => ({ ...prev, [videoId]: false }));
    }
  }

  function onSelectFolder(videoId: string) {
    setSelectedVideoId(videoId);

    if (!initializedMap[videoId]) {
      void fetchFolderClips(videoId, false);
    }
  }

  useEffect(() => {
    if (!requestedVideoId) {
      return;
    }

    const exists = folders.some((folder) => folder.videoId === requestedVideoId);
    if (!exists) {
      return;
    }

    setSelectedVideoId((prev) => prev || requestedVideoId);
  }, [requestedVideoId, folders]);

  useEffect(() => {
    if (!selectedVideoId) {
      return;
    }

    if (!initializedMap[selectedVideoId]) {
      void fetchFolderClips(selectedVideoId, false);
    }
  }, [selectedVideoId, initializedMap]);

  useEffect(() => {
    if (!selectedVideoId) {
      return;
    }

    const node = clipSentinelRef.current;
    if (!node) {
      return;
    }

    if (!initializedMap[selectedVideoId] || loadingMap[selectedVideoId] || !hasMoreMap[selectedVideoId]) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (!first?.isIntersecting) {
          return;
        }

        void fetchFolderClips(selectedVideoId, true);
      },
      {
        rootMargin: "320px 0px",
        threshold: 0,
      }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [selectedVideoId, initializedMap, loadingMap, hasMoreMap]);

  return (
    <div className="relative z-10 h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="rounded-xl border border-white/10 bg-[#131313]/70 p-5 sm:p-6">
          <h1 className="text-2xl sm:text-3xl font-black text-white font-headline tracking-wide uppercase">
            Clips Library
          </h1>
          <p className="mt-2 text-sm text-[#c3c0bf]">
            Pilih folder video source untuk melihat clip hasil render.
          </p>
        </div>

        {folders.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/20 bg-[#111]/70 p-8 text-center text-[#adaaaa]">
            Belum ada clips. Jalankan pipeline di Dashboard untuk menghasilkan clip.
          </div>
        )}

        {folders.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {folders.map((folder) => (
                <FolderCard
                  key={folder.videoId}
                  folder={folder}
                  isActive={selectedVideoId === folder.videoId}
                  onSelect={onSelectFolder}
                />
              ))}
            </div>

            <section className="rounded-xl border border-white/10 bg-[#101010]/70 p-5 sm:p-6 space-y-5">
              {!selectedFolder && (
                <div className="rounded-lg border border-dashed border-white/20 p-8 text-center text-[#9e9a98]">
                  Klik salah satu folder di atas untuk membuka daftar clip.
                </div>
              )}

              {selectedFolder && (
                <>
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <h2 className="text-xl font-black text-white uppercase tracking-wide">
                        Folder: {selectedFolder.video.sourceTitle?.trim() || "Untitled Source"}
                      </h2>
                      <p className="text-xs text-[#aaa6a4] mt-1">
                        {selectedFolder.video.sourcePlatform || "unknown"} • {selectedFolder.clipCount} clip
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedVideoId(null)}
                      className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#d5d2d1] border border-white/20 hover:border-white/35"
                    >
                      Tutup Folder
                    </button>
                  </div>

                  {errorMap[selectedFolder.videoId] && (
                    <div className="rounded-lg border border-[#ff716c]/30 bg-[#331817]/50 px-4 py-3 text-sm text-[#ffaaa4]">
                      {errorMap[selectedFolder.videoId]}
                    </div>
                  )}

                  {selectedClips.length === 0 && loadingMap[selectedFolder.videoId] && (
                    <p className="text-sm text-[#a7a3a1]">Memuat clips folder ini...</p>
                  )}

                  {selectedClips.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                      {selectedClips.map((clip) => (
                        <LibraryClipCard key={clip.id} clip={clip} />
                      ))}
                    </div>
                  )}

                  <div ref={clipSentinelRef} className="h-1" aria-hidden="true" />

                  {loadingMap[selectedFolder.videoId] && selectedClips.length > 0 && (
                    <p className="text-center text-xs text-[#8a8787]">Memuat clip berikutnya...</p>
                  )}

                  {!loadingMap[selectedFolder.videoId] && !hasMoreMap[selectedFolder.videoId] && selectedClips.length > 0 && (
                    <p className="text-center text-xs text-[#7f7b79]">Semua clip pada folder ini sudah ditampilkan.</p>
                  )}

                  {!loadingMap[selectedFolder.videoId] && selectedClips.length === 0 && initializedMap[selectedFolder.videoId] && !errorMap[selectedFolder.videoId] && (
                    <p className="text-sm text-[#a7a3a1]">Folder ini belum punya clip siap tampil.</p>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
