import { GradientButton } from "@/components/common/gradient-button";
import { MaterialIcon } from "@/components/common/material-icon";

type ProduceClipsCtaProps = {
  onClick: () => void;
  disabled?: boolean;
  isProcessing?: boolean;
};

export function ProduceClipsCta({
  onClick,
  disabled = false,
  isProcessing = false,
}: ProduceClipsCtaProps) {
  return (
    <div className="flex justify-center">
      <GradientButton
        onClick={onClick}
        disabled={disabled}
        className="group relative w-full px-6 py-4 bg-white text-black text-sm font-black uppercase tracking-[0.12em] hover:bg-white/90 disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-between"
      >
        <span className="flex items-center gap-3">
          <MaterialIcon name="auto_videocam" filled />
          {isProcessing ? "Processing..." : "Produce Clips"}
        </span>
        <MaterialIcon name="arrow_forward" className="transition-transform group-hover:translate-x-1" />
      </GradientButton>
    </div>
  );
}
