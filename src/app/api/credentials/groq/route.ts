import { NextRequest, NextResponse } from "next/server";

import { isValidSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { encryptSecret, fingerprintSecret } from "@/lib/crypto";
import { prisma } from "@/lib/prisma";

const PROVIDER = "groq" as const;

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    if (!isValidSessionToken(token)) {
      return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json()) as { apiKey?: string };
    const apiKey = body.apiKey?.trim() ?? "";

    if (!apiKey) {
      return NextResponse.json({ ok: false, message: "API key is required" }, { status: 400 });
    }

    if (!apiKey.startsWith("gsk_") || apiKey.length < 20) {
      return NextResponse.json({ ok: false, message: "Invalid Groq API key format" }, { status: 400 });
    }

    const ownerRef = process.env.SINGLE_OWNER_REF ?? "self";
    const keyFingerprint = fingerprintSecret(apiKey);
    const encryptedApiKey = encryptSecret(apiKey);

    await prisma.$transaction(async (tx) => {
      const existing = await tx.apiCredential.findFirst({
        where: {
          ownerRef,
          provider: PROVIDER,
          keyFingerprint,
        },
      });

      await tx.apiCredential.updateMany({
        where: {
          ownerRef,
          provider: PROVIDER,
          isActive: true,
        },
        data: {
          isActive: false,
          revokedAt: new Date(),
        },
      });

      if (existing) {
        await tx.apiCredential.update({
          where: { id: existing.id },
          data: {
            encryptedApiKey,
            isActive: true,
            revokedAt: null,
            lastUsedAt: new Date(),
            metadata: {
              source: "dashboard",
              updatedAt: new Date().toISOString(),
            },
          },
        });
        return;
      }

      await tx.apiCredential.create({
        data: {
          provider: PROVIDER,
          ownerRef,
          encryptedApiKey,
          keyFingerprint,
          isActive: true,
          metadata: {
            source: "dashboard",
            createdAt: new Date().toISOString(),
          },
        },
      });
    });

    return NextResponse.json({
      ok: true,
      message: "Groq API key saved",
      fingerprint: keyFingerprint,
    });
  } catch {
    return NextResponse.json(
      { ok: false, message: "Failed to save API key" },
      {
        status: 500,
      }
    );
  }
}
