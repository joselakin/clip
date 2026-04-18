import { MaterialIcon } from "@/components/common/material-icon";
import {
  CLIP_COUNT_OPTIONS,
  CLIP_DURATION_PRESETS,
  type ClipCountTarget,
  getClipDurationPresetConfig,
  type ClipDurationPreset,
} from "@/lib/clip-duration";
import {
  DEFAULT_EMOTION_CONTEXT,
  EMOTION_CONTEXT_OPTIONS,
  type EmotionContext,
} from "@/lib/emotion-context";

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
  clipCountTarget?: ClipCountTarget;
  onClipCountTargetChange?: (value: ClipCountTarget) => void;
  emotionContext?: EmotionContext;
  onEmotionContextChange?: (value: EmotionContext) => void;
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
  clipCountTarget = 6,
  onClipCountTargetChange,
  emotionContext = DEFAULT_EMOTION_CONTEXT,
  onEmotionContextChange,
  disabled = false,
}: VideoSourceInputProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center bg-[#1b1b1b] border-l-4 border-white">
        <div className="flex-1 flex items-center px-5">
          <MaterialIcon name="link" className="text-white/60 mr-3" />
          <input
            className="w-full bg-transparent border-none focus:ring-0 text-sm sm:text-base font-medium text-white placeholder:text-white/40 py-4"
            placeholder="Paste YouTube link atau upload file"
            type="text"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            disabled={disabled}
          />
        </div>
        <label
          htmlFor="dashboard-video-upload"
          className="bg-white text-black hover:bg-white/90 px-4 py-4 transition-colors cursor-pointer text-xs font-bold uppercase tracking-wider"
          aria-label="Upload file"
        >
          <span className="inline-flex items-center gap-2">
            <MaterialIcon name="upload_file" className="text-base" />
            Upload
          </span>
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
        <p className="text-xs text-white/70 font-semibold tracking-wide">
          Selected file: {selectedFileName}
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">Jumlah Hasil Video</p>

          <div className="grid grid-cols-3 gap-2">
            {CLIP_COUNT_OPTIONS.map((count) => {
              const isActive = clipCountTarget === count;
              return (
                <button
                  key={count}
                  type="button"
                  disabled={disabled}
                  onClick={() => onClipCountTargetChange?.(count)}
                  className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                    isActive
                      ? "border-white bg-white text-black"
                      : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
                  }`}
                >
                  {count} video
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-white/45">Pilih jumlah output clip. Maksimal 10 video per proses.</p>
        </div>

        <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">Durasi Konten</p>

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
                  className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                    isActive
                      ? "border-white bg-white text-black"
                      : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
                  }`}
                >
                  {config.label}
                </button>
              );
            })}
          </div>

          <p className="text-[11px] text-white/45">
            Atur gaya durasi clip: singkat, medium, panjang (maks ~5 menit), atau campuran otomatis.
          </p>
        </div>
      </div>

      <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">Emotion Context</p>
        <select
          className="w-full bg-black border border-white/20 px-3 py-2 text-sm text-white focus:outline-none focus:ring-1 focus:ring-white/50"
          value={emotionContext}
          onChange={(event) => onEmotionContextChange?.(event.target.value as EmotionContext)}
          disabled={disabled}
        >
          {EMOTION_CONTEXT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-white/45">
          Pilih nuansa emosi utama yang ingin diprioritaskan AI saat memilih highlight.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">Layout Render</p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRenderLayoutModeChange?.("standard")}
              className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                renderLayoutMode === "standard"
                  ? "border-white bg-white text-black"
                  : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
              }`}
            >
              Layout Biasa
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => onRenderLayoutModeChange?.("framed")}
              className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                renderLayoutMode === "framed"
                  ? "border-white bg-white text-black"
                  : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
              }`}
            >
              Layout Frame
            </button>
          </div>

          <p className="text-[11px] text-white/45">
            Frame: area watermark atas, konten di tengah, subtitle di bawah, dengan background hitam.
          </p>
        </div>

        <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">
            Podcast 2 Orang (Auto Camera Switch)
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPodcastTwoSpeakerModeChange?.(false)}
              className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                !podcastTwoSpeakerMode
                  ? "border-white bg-white text-black"
                  : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
              }`}
            >
              Off
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => onPodcastTwoSpeakerModeChange?.(true)}
              className={`px-3 py-2 text-xs font-bold uppercase tracking-wide border transition-colors ${
                podcastTwoSpeakerMode
                  ? "border-white bg-white text-black"
                  : "border-white/20 bg-[#171717] text-white/60 hover:text-white"
              }`}
            >
              On
            </button>
          </div>

          <p className="text-[11px] text-white/45">
            Saat aktif, sistem akan mencoba mendeteksi dua speaker dan mengganti crop kamera secara
            otomatis mengikuti speaker yang sedang bicara. Mode ini lebih berat secara komputasi.
          </p>
        </div>
      </div>

      <div className="border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/60">
          Optional Watermark
        </p>

        <input
          className="w-full bg-black border border-white/20 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-1 focus:ring-white/50"
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
            className="inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold border border-white/20 text-white/80 hover:text-white hover:border-white/50 cursor-pointer transition-colors"
          >
            <MaterialIcon name="image" className="text-white/80" />
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
            <span className="text-xs text-white/80 font-semibold">{selectedWatermarkLogoName}</span>
          )}
        </div>

        <p className="text-[11px] text-white/45">
          Watermark akan ditempatkan di tengah video dengan opacity rendah agar tidak mengganggu konten.
        </p>
      </div>
    </div>
  );
}
