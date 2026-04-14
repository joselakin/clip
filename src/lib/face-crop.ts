import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { createLogger } from "@/lib/logger";

const execFileAsync = promisify(execFile);
const logger = createLogger("lib/face-crop");

type CropRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FaceCropPlan = {
  faceFound: boolean;
  crop: CropRect;
  sampledFrames: number;
  detectedFrames: number;
  sampleStep: number;
};

function getPythonBin(): string {
  return process.env.PYTHON_BIN?.trim() || "python3";
}

function getCropScriptPath(): string {
  const configured = process.env.FACE_CROP_SCRIPT_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  }

  return path.join(process.cwd(), "face-detection", "crop_plan.py");
}

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Crop planner output tidak valid");
  }
  return raw.slice(start, end + 1);
}

export async function computeFaceCropPlan(videoPath: string, targetWidth = 1080, targetHeight = 1920) {
  const sampleFps = process.env.FACE_DETECTION_SAMPLE_FPS?.trim() || "2";

  logger.info("crop_plan_started", { videoPath, targetWidth, targetHeight, sampleFps });

  const { stdout, stderr } = await execFileAsync(getPythonBin(), [
    getCropScriptPath(),
    "--input",
    videoPath,
    "--target-width",
    String(targetWidth),
    "--target-height",
    String(targetHeight),
    "--sample-fps",
    sampleFps,
  ]);

  const output = `${stdout || ""}\n${stderr || ""}`.trim();
  const parsed = JSON.parse(extractJson(output)) as {
    ok?: boolean;
    message?: string;
    faceFound?: boolean;
    sampledFrames?: number;
    detectedFrames?: number;
    sampleStep?: number;
    crop?: CropRect;
  };

  if (!parsed.ok || !parsed.crop) {
    logger.error("crop_plan_failed", { message: parsed.message || "Face crop planner gagal" });
    throw new Error(parsed.message || "Face crop planner gagal");
  }

  logger.info("crop_plan_completed", {
    faceFound: Boolean(parsed.faceFound),
    sampledFrames: Number(parsed.sampledFrames || 0),
    detectedFrames: Number(parsed.detectedFrames || 0),
  });

  return {
    faceFound: Boolean(parsed.faceFound),
    sampledFrames: Number(parsed.sampledFrames || 0),
    detectedFrames: Number(parsed.detectedFrames || 0),
    sampleStep: Number(parsed.sampleStep || 0),
    crop: {
      x: Math.max(0, Math.round(parsed.crop.x)),
      y: Math.max(0, Math.round(parsed.crop.y)),
      w: Math.max(2, Math.round(parsed.crop.w)),
      h: Math.max(2, Math.round(parsed.crop.h)),
    },
  } as FaceCropPlan;
}
