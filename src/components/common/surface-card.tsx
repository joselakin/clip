import type { ReactNode } from "react";

type SurfaceCardProps = {
  title: string;
  subtitle: string;
  accentClassName: string;
  className?: string;
  children?: ReactNode;
};

export function SurfaceCard({
  title,
  subtitle,
  accentClassName,
  className,
  children,
}: SurfaceCardProps) {
  return (
    <div
      className={`w-32 h-32 rounded-2xl bg-surface-container-low border border-white/5 flex flex-col items-center justify-center p-4 ${
        className ?? ""
      }`.trim()}
    >
      {children ?? <span className={`${accentClassName} font-headline font-black text-2xl`}>{title}</span>}
      <span className="text-[10px] text-[#adaaaa] font-bold uppercase">{subtitle}</span>
    </div>
  );
}
