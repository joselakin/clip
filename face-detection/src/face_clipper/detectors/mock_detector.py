from face_clipper.types import BoundingBox


class MockFaceDetector:
    """Temporary detector for integration scaffolding."""

    def detect(self, frame: object) -> list[BoundingBox]:
        _ = frame
        return [BoundingBox(x=400, y=120, w=220, h=220)]
