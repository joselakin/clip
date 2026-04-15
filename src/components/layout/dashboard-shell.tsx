"use client";

import { useState } from "react";

import { DashboardSidebar } from "@/components/layout/dashboard-sidebar";
import { DashboardTopNav } from "@/components/layout/dashboard-top-nav";

type DashboardShellProps = {
  children: React.ReactNode;
  activeSection?: "dashboard" | "library";
};

export function DashboardShell({ children, activeSection = "dashboard" }: DashboardShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <DashboardSidebar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        activeSection={activeSection}
      />

      {menuOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          aria-label="Close sidebar overlay"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <DashboardTopNav onMenuToggle={() => setMenuOpen((prev) => !prev)} />

      <main className="ml-0 lg:ml-64 pt-16 relative bg-surface min-h-screen overflow-x-hidden">{children}</main>
    </div>
  );
}
