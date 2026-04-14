#!/usr/bin/env python3
"""Compute portrait crop plan from face detection on sampled frames."""

import argparse
import json
import os
import subprocess
import statistics
import sys
from typing import Any


def _clamp(value: int, min_value: int, max_value: int) -> int:
    return max(min_value, min(value, max_value))


def _even(value: int, min_value: int = 2) -> int:
    if value < min_value:
        value = min_value
    return value if value % 2 == 0 else value - 1


def _parse_fps(raw: str | None) -> float:
    if not raw:
        return 0.0

    if "/" in raw:
        num_raw, den_raw = raw.split("/", 1)
        try:
            num = float(num_raw)
            den = float(den_raw)
            if den <= 0:
                return 0.0
            return num / den
        except ValueError:
            return 0.0

    try:
        return float(raw)
    except ValueError:
        return 0.0


def _load_cv2() -> Any | None:
    try:
        import cv2  # type: ignore

        return cv2
    except ModuleNotFoundError:
        return None


def _probe_video_with_ffprobe(input_path: str) -> tuple[int, int, float, int]:
    ffprobe_bin = os.environ.get("FFPROBE_PATH", "ffprobe")
    process = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_streams",
            "-show_format",
            input_path,
        ],
        capture_output=True,
        text=True,
        check=True,
    )

    parsed = json.loads(process.stdout or "{}")
    streams = parsed.get("streams") or []
    video_stream = next((item for item in streams if item.get("codec_type") == "video"), None)

    if not video_stream:
        raise ValueError("ffprobe tidak menemukan stream video")

    width = int(video_stream.get("width") or 0)
    height = int(video_stream.get("height") or 0)
    fps = _parse_fps(video_stream.get("r_frame_rate"))
    frame_count = int(video_stream.get("nb_frames") or 0)

    if frame_count <= 0:
        duration = float((parsed.get("format") or {}).get("duration") or 0.0)
        if duration > 0 and fps > 0:
            frame_count = int(round(duration * fps))

    return width, height, fps, frame_count


def _compute_crop_window(
    width: int,
    height: int,
    target_width: int,
    target_height: int,
    center_x: float,
    center_y: float,
) -> dict[str, int]:
    target_ratio = float(target_width) / float(target_height)
    source_ratio = float(width) / float(height)

    if source_ratio >= target_ratio:
        crop_h = _even(height)
        crop_w = _even(int(round(crop_h * target_ratio)))
        crop_w = min(crop_w, _even(width))
        crop_x = _clamp(int(round(center_x - (crop_w / 2))), 0, max(0, width - crop_w))
        crop_y = 0
    else:
        crop_w = _even(width)
        crop_h = _even(int(round(crop_w / target_ratio)))
        crop_h = min(crop_h, _even(height))
        crop_x = 0
        crop_y = _clamp(int(round(center_y - (crop_h / 2))), 0, max(0, height - crop_h))

    return {
        "x": crop_x,
        "y": crop_y,
        "w": crop_w,
        "h": crop_h,
    }


def _build_fallback_result(
    args: argparse.Namespace,
    width: int,
    height: int,
    fps: float,
    frame_count: int,
    message: str,
) -> dict[str, Any]:
    sample_step = max(1, int(round((fps if fps > 0 else 25.0) / max(args.sample_fps, 0.2))))
    crop = _compute_crop_window(
        width=width,
        height=height,
        target_width=args.target_width,
        target_height=args.target_height,
        center_x=width / 2.0,
        center_y=height / 2.0,
    )

    return {
        "ok": True,
        "message": message,
        "inputWidth": width,
        "inputHeight": height,
        "fps": fps if fps > 0 else 25.0,
        "frameCount": frame_count,
        "sampleStep": sample_step,
        "sampledFrames": 0,
        "faceFound": False,
        "detectedFrames": 0,
        "crop": crop,
        "target": {
            "width": int(args.target_width),
            "height": int(args.target_height),
        },
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Face-aware crop planner")
    parser.add_argument("--input", required=True, help="Input video path")
    parser.add_argument("--target-width", type=int, default=1080)
    parser.add_argument("--target-height", type=int, default=1920)
    parser.add_argument("--sample-fps", type=float, default=2.0)
    parser.add_argument("--scale-factor", type=float, default=1.1)
    parser.add_argument("--min-neighbors", type=int, default=5)
    return parser.parse_args()


def build_plan(args: argparse.Namespace) -> dict[str, Any]:
    cv2 = _load_cv2()
    if cv2 is None:
        width, height, fps, frame_count = _probe_video_with_ffprobe(args.input)
        return _build_fallback_result(
            args,
            width,
            height,
            fps,
            frame_count,
            "cv2 not installed, fallback to center crop",
        )

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        width, height, fps, frame_count = _probe_video_with_ffprobe(args.input)
        return _build_fallback_result(
            args,
            width,
            height,
            fps,
            frame_count,
            "unable to open with cv2, fallback to ffprobe center crop",
        )

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0.0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    if width <= 0 or height <= 0:
        cap.release()
        width, height, fps, frame_count = _probe_video_with_ffprobe(args.input)
        return _build_fallback_result(
            args,
            width,
            height,
            fps,
            frame_count,
            "invalid cv2 frame size, fallback to ffprobe center crop",
        )

    if fps <= 0:
        fps = 25.0

    sample_step = max(1, int(round(fps / max(args.sample_fps, 0.2))))

    classifier = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
    if classifier.empty():
        cap.release()
        return _build_fallback_result(
            args,
            width,
            height,
            fps,
            frame_count,
            "failed to load Haar cascade, fallback to center crop",
        )

    centers_x: list[float] = []
    centers_y: list[float] = []
    sampled = 0

    min_face = max(32, int(min(width, height) * 0.07))

    frame_idx = 0
    while frame_idx < max(frame_count, 1):
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            frame_idx += sample_step
            continue

        sampled += 1
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        faces = classifier.detectMultiScale(
            gray,
            scaleFactor=args.scale_factor,
            minNeighbors=args.min_neighbors,
            minSize=(min_face, min_face),
        )

        if len(faces) > 0:
            largest = max(faces, key=lambda f: f[2] * f[3])
            x, y, w, h = [int(v) for v in largest]
            centers_x.append(x + (w / 2.0))
            centers_y.append(y + (h / 2.0))

        frame_idx += sample_step

    cap.release()

    face_found = len(centers_x) > 0
    center_x = statistics.median(centers_x) if face_found else width / 2.0
    center_y = statistics.median(centers_y) if face_found else height / 2.0
    crop = _compute_crop_window(
        width=width,
        height=height,
        target_width=args.target_width,
        target_height=args.target_height,
        center_x=center_x,
        center_y=center_y,
    )

    return {
        "ok": True,
        "inputWidth": width,
        "inputHeight": height,
        "fps": fps,
        "frameCount": frame_count,
        "sampleStep": sample_step,
        "sampledFrames": sampled,
        "faceFound": face_found,
        "detectedFrames": len(centers_x),
        "crop": crop,
        "target": {
            "width": int(args.target_width),
            "height": int(args.target_height),
        },
    }


def main() -> int:
    args = parse_args()

    try:
        result = build_plan(args)
    except Exception as exc:  # pylint: disable=broad-except
        print(json.dumps({"ok": False, "message": str(exc)}))
        return 1

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
