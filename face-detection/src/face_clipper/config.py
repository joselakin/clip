from dataclasses import dataclass


@dataclass(slots=True)
class CropConfig:
    """Configuration for portrait crop planning."""

    output_width: int = 1080
    output_height: int = 1920
    smoothing_alpha: float = 0.35
    max_horizontal_speed_px: int = 60
    sample_fps: int = 5
