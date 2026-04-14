import { MaterialIcon } from "@/components/common/material-icon";

type VideoSourceInputProps = {
  value: string;
  onChange: (value: string) => void;
  onFileSelect?: (file: File | null) => void;
  selectedFileName?: string | null;
  disabled?: boolean;
};

export function VideoSourceInput({
  value,
  onChange,
  onFileSelect,
  selectedFileName,
  disabled = false,
}: VideoSourceInputProps) {
  return (
    <div className="relative group">
      <div className="absolute -inset-0.5 bg-gradient-to-r from-[#85adff]/20 to-[#0c70ea]/20 rounded-2xl blur opacity-30 group-focus-within:opacity-100 transition duration-1000 group-focus-within:duration-200" />
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
    </div>
  );
}
