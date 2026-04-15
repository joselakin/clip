import path from "node:path";

export type RenderLayout = "standard" | "framed";

function escapeForFfmpegSubtitlesPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/'/g, "\\'");
}

export function buildSubtitleFilterArg(subtitlePath: string): string {
  const escapedSubtitlePath = escapeForFfmpegSubtitlesPath(subtitlePath);
  const configuredFontsDir = process.env.SUBTITLE_FONTS_DIR?.trim();

  if (!configuredFontsDir) {
    return `subtitles=${escapedSubtitlePath}`;
  }

  const fontsDir = path.isAbsolute(configuredFontsDir)
    ? configuredFontsDir
    : path.join(process.cwd(), configuredFontsDir);
  const escapedFontsDir = escapeForFfmpegSubtitlesPath(fontsDir);
  return `subtitles=${escapedSubtitlePath}:fontsdir=${escapedFontsDir}`;
}

export function clampOpacity(value?: number): number {
  const raw = typeof value === "number" ? value : 0.16;
  if (!Number.isFinite(raw)) {
    return 0.16;
  }
  return Math.max(0.05, Math.min(0.5, raw));
}

function escapeDrawtextText(input: string): string {
  return input
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, " ");
}

function buildDrawtextFilter(text: string, opacity: number): string {
  const safeText = escapeDrawtextText(text.trim());
  return `drawtext=text='${safeText}':fontcolor=white@${opacity.toFixed(2)}:fontsize=72:x=(w-text_w)/2:y=(h-text_h)/2`;
}

export function buildDrawtextFilterForLayout(
  text: string,
  opacity: number,
  layout: RenderLayout
): string {
  if (layout === "framed") {
    const safeText = escapeDrawtextText(text.trim());
    return `drawtext=text='${safeText}':fontcolor=white@${Math.min(0.85, opacity + 0.2).toFixed(2)}:fontsize=58:borderw=2:bordercolor=black@0.45:x=(w-text_w)/2:y=166`;
  }

  return buildDrawtextFilter(text, opacity);
}

export function buildFramedLayoutFilters(): string[] {
  // Keep this close to Tailwind rounded-xl visual feel on the inner square.
  const corner = 28;
  const size = 820;

  // Mark pixels outside rounded corners so we can force them to black.
  const outsideCornerExpr = [
    `lt(X,${corner})*lt(Y,${corner})*gt(pow(X-${corner},2)+pow(Y-${corner},2),pow(${corner},2))`,
    `+gt(X,W-${corner}-1)*lt(Y,${corner})*gt(pow(X-(W-${corner}-1),2)+pow(Y-${corner},2),pow(${corner},2))`,
    `+lt(X,${corner})*gt(Y,H-${corner}-1)*gt(pow(X-${corner},2)+pow(Y-(H-${corner}-1),2),pow(${corner},2))`,
    `+gt(X,W-${corner}-1)*gt(Y,H-${corner}-1)*gt(pow(X-(W-${corner}-1),2)+pow(Y-(H-${corner}-1),2),pow(${corner},2))`,
  ].join("");

  return [
    "crop='min(iw,ih)':'min(iw,ih)'",
    `scale=${size}:${size}`,
    "format=rgb24",
    `geq=r='if(${outsideCornerExpr},0,r(X,Y))':g='if(${outsideCornerExpr},0,g(X,Y))':b='if(${outsideCornerExpr},0,b(X,Y))'`,
    "pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black",
  ];
}
