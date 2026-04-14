import { NextRequest, NextResponse } from "next/server";

import {
  buildSessionToken,
  isValidPassword,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/lib/auth";

export async function POST(request: NextRequest) {
  if (!process.env.APP_PASSWORD) {
    return NextResponse.json(
      { ok: false, message: "APP_PASSWORD belum diset di environment" },
      { status: 500 }
    );
  }

  const body = (await request.json()) as { password?: string };
  const password = body.password?.trim() ?? "";

  if (!password) {
    return NextResponse.json({ ok: false, message: "Password wajib diisi" }, { status: 400 });
  }

  if (!isValidPassword(password)) {
    return NextResponse.json({ ok: false, message: "Password salah" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, message: "Login berhasil" });
  response.cookies.set(SESSION_COOKIE_NAME, buildSessionToken(), sessionCookieOptions);

  return response;
}
