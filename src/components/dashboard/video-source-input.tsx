import { MaterialIcon } from "@/components/common/material-icon";
import {
  CLIP_DURATION_PRESETS,
  getClipDurationPresetConfig,
  type ClipDurationPreset,
} from "@/lib/clip-duration";

type VideoSourceInputProps = {
  value: string;
  onChange: (value: string) => void;
  onFileSelect?: (file: File | null) => void;
  selectedFileName?: string | null;
  renderLayoutMode?: "standard" | "framed";
  onRenderLayoutModeChange?: (value: "standard" | "framed") => void;
  podcastTwoSpeakerMode?: boolean;
  onPodcastTwoSpeakerModeChange?: (value: boolean) => void;
  watermarkText?: string;
  onWatermarkTextChange?: (value: string) => void;
  onWatermarkLogoSelect?: (file: File | null) => void;
  selectedWatermarkLogoName?: string | null;
  clipDurationPreset?: ClipDurationPreset;
  onClipDurationPresetChange?: (value: ClipDurationPreset) => void;
  disabled?: boolean;
};

export function VideoSourceInput({
  value,
  onChange,
  onFileSelect,
  selectedFileName,
  renderLayoutMode = "standard",
  onRenderLayoutModeChange,
  podcastTwoSpeakerMode = false,
  onPodcastTwoSpeakerModeChange,
  watermarkText = "",
  onWatermarkTextChange,
  onWatermarkLogoSelect,
  selectedWatermarkLogoName,
  clipDurationPreset = "under_1_minute",
  onClipDurationPresetChange,
  disabled = false,
}: VideoSourceInputProps) {
  return (
    <div className="relative group">
      <div className="absolute -inset-0.5 bg-gradient-to-r from-[#85adff]/20 to-[#0c70ea]/20 rounded-2xl blur opacity-30 group-focus-within:opacity-100 transition duration-1000 group-focus-within:duration-200 pointer-events-none" />
      <div className="relative flex items-center bg-surface-container-high rounded-2xl p-2 shadow-2xl">
        <div className="flex-1 flex items-center px-6">
          <MaterialIcon name="link" className="text-[#adaaaa] mr-4" />
          <input
            className="w-full bg-transparent border-none focus:ring-0 text-lg sm:text-xl font-medium text-white placeholder-[#5c5b5b] py-6"
            placeholder="Paste YouTube link atau upload file"
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </div>
        <label
          htmlFor="dashboard-video-upload"
          className="bg-surface-container-highest hover:bg-surface-bright p-6 rounded-xl transition-colors group/upload cursor-pointer"
          aria-label="Upload file"
        >
          <MaterialIcon
            name="upload_file"
            className="text-[#85adff] group-hover/upload:scale-110 transition-transform"
          />
        </label>
        <input
          id="dashboard-video-upload"
          type="file"
          accept="video/*"
          className="hidden"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0] || null;
            onFileSelect?.(file);
          }}
        />
      </div>
      {selectedFileName && (
        <p className="mt-3 text-xs text-[#85adff] font-semibold tracking-wide">
          Selected file: {selectedFileName}
        </p>
      )}

      <div className="mt-4 rounded-xl border border-white/10 bg-[#121212]/80 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#c3c0bf]">Durasi Konten</p>

        <div className="grid grid-cols-2 gap-2">
          {CLIP_DURATION_PRESETS.map((preset) => {
            const config = getClipDurationPresetConfig(preset);
            const isActive = clipDurationPreset === preset;
            return (
              <button
                key={preset}
                type="button"
                disabled={disabled}
                onClick={() => onClipDurationPresetChange?.(preset)}
                className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                  isActive
                    ? "border-[#85adff]/70 bg-[#1a2640] text-[#9dc0ff]"
                    : "border-white/15 bg-[#171717] text-[#bcb8b6] hover:border-white/30"
                }`}
              >
                {config.label}
              </button>
            );
          })}
        </div>

        <p className="text-[11px] text-[#8f8b89]">
          Atur gaya durasi clip: singkat, medium, panjang (maks ~5 menit), atau campuran otomatis.
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-[#121212]/80 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#c3c0bf]">Layout Render</p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRenderLayoutModeChange?.("standard")}
            className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
              renderLayoutMode === "standard"
                ? "border-[#85adff]/70 bg-[#1a2640] text-[#9dc0ff]"
                : "border-white/15 bg-[#171717] text-[#bcb8b6] hover:border-white/30"
            }`}
          >
            Layout Biasa
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onRenderLayoutModeChange?.("framed")}
            className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
              renderLayoutMode === "framed"
                ? "border-[#85adff]/70 bg-[#1a2640] text-[#9dc0ff]"
                : "border-white/15 bg-[#171717] text-[#bcb8b6] hover:border-white/30"
            }`}
          >
            Layout Frame
          </button>
        </div>

        <p className="text-[11px] text-[#8f8b89]">
          Frame: area watermark atas, konten di tengah, subtitle di bawah, dengan background hitam.
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-[#121212]/80 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#c3c0bf]">
          Podcast 2 Orang (Auto Camera Switch)
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPodcastTwoSpeakerModeChange?.(false)}
            className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
              !podcastTwoSpeakerMode
                ? "border-[#85adff]/70 bg-[#1a2640] text-[#9dc0ff]"
                : "border-white/15 bg-[#171717] text-[#bcb8b6] hover:border-white/30"
            }`}
          >
            Off
          </button>

          <button
            type="button"
            disabled={disabled}
            onClick={() => onPodcastTwoSpeakerModeChange?.(true)}
            className={`rounded-lg px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
              podcastTwoSpeakerMode
                ? "border-[#85adff]/70 bg-[#1a2640] text-[#9dc0ff]"
                : "border-white/15 bg-[#171717] text-[#bcb8b6] hover:border-white/30"
            }`}
          >
            On
          </button>
        </div>

        <p className="text-[11px] text-[#8f8b89]">
          Saat aktif, sistem akan mencoba mendeteksi dua speaker dan mengganti crop kamera secara
          otomatis mengikuti speaker yang sedang bicara. Mode ini lebih berat secara komputasi.
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-white/10 bg-[#121212]/80 p-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[#c3c0bf]">
          Optional Watermark
        </p>

        <input
          className="w-full bg-[#1a1a1a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:ring-2 focus:ring-[#85adff]/30"
          placeholder="Watermark teks (contoh: @brandkamu)"
          type="text"
          value={watermarkText}
          onChange={(event) => onWatermarkTextChange?.(event.target.value)}
          disabled={disabled}
          maxLength={120}
        />

        <div className="flex items-center gap-3">
          <label
            htmlFor="dashboard-watermark-logo"
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold border border-white/20 text-[#d2d0cf] hover:border-[#85adff]/60 cursor-pointer transition-colors"
          >
            <MaterialIcon name="image" className="text-[#85adff]" />
            Upload Logo Watermark
          </label>
          <input
            id="dashboard-watermark-logo"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            disabled={disabled}
            onChange={(event) => {
              const file = event.target.files?.[0] || null;
              onWatermarkLogoSelect?.(file);
            }}
          />
          {selectedWatermarkLogoName && (
            <span className="text-xs text-[#85adff] font-semibold">{selectedWatermarkLogoName}</span>
          )}
        </div>

        <p className="text-[11px] text-[#8f8b89]">
          Watermark akan ditempatkan di tengah video dengan opacity rendah agar tidak mengganggu konten.
        </p>
      </div>
    </div>
  );
}
