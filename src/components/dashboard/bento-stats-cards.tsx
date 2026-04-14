import { SurfaceCard } from "@/components/common/surface-card";

export function BentoStatsCards() {
  return (
    <div className="absolute bottom-12 right-12 hidden lg:flex gap-4 pointer-events-none opacity-40">
      <SurfaceCard title="4K" subtitle="Resolution" accentClassName="text-[#85adff]" />
      <SurfaceCard title="AI" subtitle="Enhanced" accentClassName="text-[#ffd16c]" />
    </div>
  );
}
