"use client";

import { useRouter } from "next/navigation";

import { MaterialIcon } from "@/components/common/material-icon";
import { NavLink } from "@/components/common/nav-link";
import { ConfigSection } from "@/components/ui/config-section";

type DashboardSidebarProps = {
  open: boolean;
  onClose: () => void;
  activeSection?: "dashboard" | "library";
};

export function DashboardSidebar({ open, onClose, activeSection = "dashboard" }: DashboardSidebarProps) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <aside
      className={`h-screen w-64 fixed left-0 top-0 bg-[#131313] transition-transform duration-300 shadow-none z-50 flex flex-col justify-between py-8 ${
        open ? "translate-x-0" : "-translate-x-full"
      } lg:translate-x-0`}
    >
      <div className="flex flex-col gap-8">
        <div className="px-6 flex items-start justify-between">
          <div>
            <span className="text-xl font-black text-[#85adff] font-headline tracking-wide uppercase">
              Master Suite
            </span>
            <p className="text-[10px] font-headline tracking-widest text-[#adaaaa] font-bold uppercase mt-1">
              Pro Production
            </p>
          </div>
          <button
            type="button"
            className="lg:hidden text-[#adaaaa] hover:text-white transition-colors"
            onClick={onClose}
            aria-label="Close menu"
          >
            <MaterialIcon name="close" />
          </button>
        </div>

        <nav className="flex flex-col">
          <NavLink
            label="Dashboard"
            icon="dashboard"
            active={activeSection === "dashboard"}
            href="/dashboard"
          />
          <NavLink
            label="Library"
            icon="video_library"
            active={activeSection === "library"}
            href="/library"
          />
          <NavLink label="Magic Clips" icon="auto_awesome" />
          <NavLink label="Automations" icon="settings_input_component" />
          <NavLink label="Settings" icon="settings" />
        </nav>

        <ConfigSection />
      </div>

      <div className="px-6 flex flex-col gap-4">
        <div className="flex flex-col gap-2 border-t border-white/5 pt-4">
          <a className="text-[#adaaaa] hover:text-white flex items-center gap-3 text-sm py-1" href="#">
            <MaterialIcon name="help" className="text-sm" />
            Help
          </a>
          <button
            type="button"
            onClick={handleLogout}
            className="text-[#adaaaa] hover:text-white flex items-center gap-3 text-sm py-1 text-left"
          >
            <MaterialIcon name="logout" className="text-sm" />
            Logout
          </button>
        </div>
      </div>
    </aside>
  );
}
