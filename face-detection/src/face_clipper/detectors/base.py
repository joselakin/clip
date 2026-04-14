from typing import Protocol

from face_clipper.types import BoundingBox


class FaceDetector(Protocol):
    """Interface for frame-level face detection."""

    def detect(self, frame: object) -> list[BoundingBox]:
        """Return all face boxes for a single frame."""
