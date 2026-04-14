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
        className="group relative px-12 py-5 rounded-full bg-gradient-to-br from-[#85adff] to-[#0c70ea] text-on-primary-fixed text-lg font-bold uppercase tracking-[0.1em] shadow-[0_0_40px_-10px_rgba(133,173,255,0.4)] hover:shadow-[0_0_60px_-5px_rgba(133,173,255,0.6)] disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <span className="flex items-center gap-3">
          <MaterialIcon name="auto_videocam" filled />
          {isProcessing ? "Processing..." : "Produce Clips"}
        </span>
      </GradientButton>
    </div>
  );
}
