import { createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "clipper_auth";

function getSessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.CREDENTIAL_ENCRYPTION_KEY || "dev-session-secret";
}

export function buildSessionToken(): string {
  return createHash("sha256").update(`clipper:${getSessionSecret()}`).digest("hex");
}

export function isValidSessionToken(token?: string): boolean {
  if (!token) {
    return false;
  }

  const expected = buildSessionToken();
  const tokenBuffer = Buffer.from(token);
  const expectedBuffer = Buffer.from(expected);

  if (tokenBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(tokenBuffer, expectedBuffer);
}

export function isValidPassword(input: string): boolean {
  const expectedPassword = process.env.APP_PASSWORD;
  if (!expectedPassword) {
    return false;
  }

  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expectedPassword);

  if (inputBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(inputBuffer, expectedBuffer);
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};
