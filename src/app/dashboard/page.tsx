import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DashboardMain } from "@/components/dashboard/dashboard-main";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!isValidSessionToken(token)) {
    redirect("/login");
  }

  return (
    <DashboardShell activeSection="dashboard">
      <DashboardMain />
    </DashboardShell>
  );
}
