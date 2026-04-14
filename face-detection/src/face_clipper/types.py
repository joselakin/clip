from dataclasses import dataclass


@dataclass(slots=True)
class FrameSize:
    width: int
    height: int


@dataclass(slots=True)
class BoundingBox:
    x: int
    y: int
    w: int
    h: int


@dataclass(slots=True)
class CropWindow:
    x: int
    y: int
    w: int
    h: int
