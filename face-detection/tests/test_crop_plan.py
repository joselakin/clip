from __future__ import annotations

import importlib.util
from argparse import Namespace
from pathlib import Path


def load_crop_plan_module():
    module_path = Path(__file__).resolve().parents[1] / "crop_plan.py"
    spec = importlib.util.spec_from_file_location("crop_plan", module_path)
    if not spec or not spec.loader:
        raise RuntimeError("Unable to load crop_plan module")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_compute_crop_window_landscape_center():
    crop_plan = load_crop_plan_module()

    crop = crop_plan._compute_crop_window(
        width=1920,
        height=1080,
        target_width=1080,
        target_height=1920,
        center_x=960.0,
        center_y=540.0,
    )

    assert crop["h"] == 1080
    assert crop["w"] == 608
    assert crop["x"] == 656
    assert crop["y"] == 0


def test_build_plan_fallback_without_cv2(monkeypatch):
    crop_plan = load_crop_plan_module()

    monkeypatch.setattr(crop_plan, "_load_cv2", lambda: None)
    monkeypatch.setattr(
        crop_plan,
        "_probe_video_with_ffprobe",
        lambda _input: (1920, 1080, 30.0, 300),
    )

    args = Namespace(
        input="dummy.mp4",
        target_width=1080,
        target_height=1920,
        sample_fps=2.0,
        scale_factor=1.1,
        min_neighbors=5,
    )

    result = crop_plan.build_plan(args)

    assert result["ok"] is True
    assert result["faceFound"] is False
    assert result["inputWidth"] == 1920
    assert result["inputHeight"] == 1080
    assert result["crop"]["w"] == 608
    assert result["crop"]["h"] == 1080
