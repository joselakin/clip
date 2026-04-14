import { MaterialIcon } from "@/components/common/material-icon";

type DashboardTopNavProps = {
  onMenuToggle: () => void;
};

export function DashboardTopNav({ onMenuToggle }: DashboardTopNavProps) {
  return (
    <header className="fixed top-0 right-0 left-0 lg:left-64 h-16 z-40 bg-[#0e0e0e]/70 backdrop-blur-xl border-b border-white/5 shadow-2xl shadow-white/5 flex items-center justify-between px-4 sm:px-8 lg:w-[calc(100%-16rem)]">
      <div className="flex items-center gap-8">
        <button
          type="button"
          className="lg:hidden text-[#adaaaa] hover:text-white transition-colors"
          onClick={onMenuToggle}
          aria-label="Open menu"
        >
          <MaterialIcon name="menu" />
        </button>

        <div className="hidden sm:flex items-center gap-6">
          <a className="text-[#85adff] font-body font-bold text-sm border-b-2 border-[#85adff] pb-1" href="#">
            Workflow
          </a>
          <a className="text-[#adaaaa] hover:text-white transition-colors font-body font-medium text-sm" href="#">
            Assets
          </a>
          <a className="text-[#adaaaa] hover:text-white transition-colors font-body font-medium text-sm" href="#">
            Analytics
          </a>
        </div>
      </div>

      <div className="flex items-center gap-3 sm:gap-6">
        <div className="flex items-center gap-3">
          <button type="button" className="text-[#adaaaa] hover:text-white transition-colors" aria-label="Notifications">
            <MaterialIcon name="notifications" />
          </button>
          <div className="w-8 h-8 rounded-full overflow-hidden border border-white/10">
            <img alt="User Profile" className="w-full h-full object-cover" src="/profile-avatar.svg" />
          </div>
        </div>

        <div className="hidden sm:flex gap-3">
          <button className="px-4 py-1.5 rounded-lg text-sm font-semibold text-white/70 hover:text-white transition-colors" type="button">
            Preview
          </button>
          <button className="px-5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-sm font-bold text-[#85adff] transition-all" type="button">
            Export
          </button>
        </div>
      </div>
    </header>
  );
}
