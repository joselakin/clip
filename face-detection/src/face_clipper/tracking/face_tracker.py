from face_clipper.types import BoundingBox


class FaceTracker:
    """Very simple EMA-like center tracker placeholder."""

    def __init__(self, alpha: float = 0.35) -> None:
        self.alpha = alpha
        self._center_x: float | None = None

    def update(self, primary_face: BoundingBox) -> float:
        face_center_x = primary_face.x + (primary_face.w / 2)
        if self._center_x is None:
            self._center_x = face_center_x
        else:
            self._center_x = (self.alpha * face_center_x) + ((1 - self.alpha) * self._center_x)
        return self._center_x
