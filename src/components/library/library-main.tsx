"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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
  } | null;
  video: {
    id: string;
    sourceTitle: string | null;
    sourcePlatform: string | null;
    sourceUrl: string | null;
  };
};

type LibraryMainProps = {
  clips: LibraryClip[];
};

const INITIAL_VISIBLE_COUNT = 9;
const VISIBLE_BATCH_SIZE = 9;

type ClipReviewView = {
  recommendedTitle: string | null;
  overallScore: number | null;
  whyThisWorks: string | null;
  improvementTip: string | null;
  scoreHook: number | null;
  scoreValue: number | null;
};

function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
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

  return {
    recommendedTitle: asString(clipReview?.recommendedTitle),
    overallScore: asScore(clipReview?.overallScore) ?? clip.highlight?.scorePercent ?? null,
    whyThisWorks: asString(clipReview?.whyThisWorks) || asString(reasonRoot?.reason),
    improvementTip: asString(clipReview?.improvementTip),
    scoreHook: asScore(clipReview?.hookScore),
    scoreValue: asScore(clipReview?.valueScore),
  };
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
            {(review.scoreHook !== null || review.scoreValue !== null) && (
              <p className="text-[11px] text-[#b8c7ea]">
                Hook {review.scoreHook ?? "-"} • Value {review.scoreValue ?? "-"}
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

export function LibraryMain({ clips }: LibraryMainProps) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_COUNT);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const visibleClips = useMemo(() => {
    return clips.slice(0, visibleCount);
  }, [clips, visibleCount]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (!first?.isIntersecting) {
          return;
        }

        setVisibleCount((prev) => {
          if (prev >= clips.length) {
            return prev;
          }
          return Math.min(clips.length, prev + VISIBLE_BATCH_SIZE);
        });
      },
      {
        rootMargin: "400px 0px",
        threshold: 0,
      }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, [clips.length]);

  const hasMore = visibleCount < clips.length;

  return (
    <div className="relative z-10 h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="rounded-xl border border-white/10 bg-[#131313]/70 p-5 sm:p-6">
          <h1 className="text-2xl sm:text-3xl font-black text-white font-headline tracking-wide uppercase">
            Clips Library
          </h1>
          <p className="mt-2 text-sm text-[#c3c0bf]">
            Preview hasil clip final dan download file siap publish.
          </p>
        </div>

        {clips.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/20 bg-[#111]/70 p-8 text-center text-[#adaaaa]">
            Belum ada clips. Jalankan pipeline di Dashboard untuk menghasilkan clip.
          </div>
        )}

        {clips.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
              {visibleClips.map((clip) => (
                <LibraryClipCard key={clip.id} clip={clip} />
              ))}
            </div>
            <div ref={sentinelRef} className="h-1" aria-hidden="true" />
            {hasMore && (
              <p className="text-center text-xs text-[#8a8787]">Memuat clip berikutnya...</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
