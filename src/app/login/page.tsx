import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";

export default async function LoginPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (isValidSessionToken(token)) {
    redirect("/dashboard");
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-[#0e0e0e] px-4">
      <section className="w-full max-w-md rounded-2xl border border-white/10 bg-[#131313] p-6 sm:p-8 shadow-2xl shadow-black/30">
        <h1 className="text-3xl font-headline font-extrabold text-white mb-2">Master Suite</h1>
        <p className="text-sm text-[#adaaaa] mb-6">Masuk dengan password untuk mengakses dashboard.</p>
        <LoginForm />
      </section>
    </main>
  );
}
