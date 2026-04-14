type LibraryClip = {
  id: string;
  startMs: number;
  endMs: number;
  outputFileKey: string;
  thumbnailKey: string | null;
  subtitleMode: "none" | "hard";
  createdAt: Date;
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

export function LibraryMain({ clips }: LibraryMainProps) {
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
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {clips.map((clip) => {
              const title = clip.video.sourceTitle?.trim() || "Untitled Source";
              const previewUrl = buildFileUrl(clip.outputFileKey);
              const downloadUrl = buildFileUrl(clip.outputFileKey, true);
              const thumbnailUrl = clip.thumbnailKey ? buildFileUrl(clip.thumbnailKey) : null;

              return (
                <article
                  key={clip.id}
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
                    <video
                      className="absolute inset-0 w-full h-full object-contain"
                      controls
                      preload="metadata"
                      src={previewUrl}
                    />
                  </div>

                  <div className="p-4 space-y-3">
                    <div>
                      <h2 className="text-sm font-bold text-white line-clamp-2">{title}</h2>
                      <p className="mt-1 text-xs text-[#9f9c9b]">
                        {formatMs(clip.startMs)} - {formatMs(clip.endMs)}
                        {clip.video.sourcePlatform ? ` • ${clip.video.sourcePlatform}` : ""}
                      </p>
                    </div>

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
            })}
          </div>
        )}
      </div>
    </div>
  );
}
