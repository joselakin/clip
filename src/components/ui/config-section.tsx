"use client";

import { useState } from "react";

export function ConfigSection() {
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!apiKey.trim()) {
      setIsError(true);
      setStatusMessage("API key wajib diisi");
      return;
    }

    setIsSaving(true);
    setIsError(false);
    setStatusMessage(null);

    try {
      const response = await fetch("/api/credentials/groq", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey }),
      });

      const result = (await response.json()) as { ok: boolean; message: string; fingerprint?: string };

      if (!response.ok || !result.ok) {
        setIsError(true);
        setStatusMessage(result.message || "Gagal menyimpan API key");
        return;
      }

      setIsError(false);
      setStatusMessage(`Saved (${result.fingerprint ?? "ok"})`);
      setApiKey("");
    } catch {
      setIsError(true);
      setStatusMessage("Terjadi kesalahan saat menyimpan API key");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="px-6 mt-4">
      <h3 className="text-[10px] font-headline tracking-[0.2em] text-[#adaaaa] font-extrabold uppercase mb-4">
        Configuration
      </h3>
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="flex flex-col gap-2">
          <label className="text-[11px] font-medium text-[#adaaaa] font-body">GROQ API Key</label>
          <input
            className="w-full bg-surface-container-highest border-none rounded-md px-3 py-2 text-sm text-white focus:ring-2 focus:ring-[#85adff]/20 placeholder-[#5c5b5b] transition-all"
            placeholder="gsk_..."
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={isSaving}
          className="w-full py-2.5 px-4 rounded-lg bg-gradient-to-br from-[#85adff] to-[#0c70ea] text-on-primary-fixed text-xs font-bold uppercase tracking-wider disabled:opacity-60 disabled:cursor-not-allowed transition-all"
        >
          {isSaving ? "Saving..." : "Save API Key"}
        </button>

        {statusMessage && (
          <p className={`text-[11px] ${isError ? "text-[#ff716c]" : "text-[#85adff]"}`}>{statusMessage}</p>
        )}
      </form>
    </div>
  );
}
