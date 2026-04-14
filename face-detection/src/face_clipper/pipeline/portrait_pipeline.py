from face_clipper.config import CropConfig
from face_clipper.detectors.base import FaceDetector
from face_clipper.planning.crop_planner import compute_portrait_crop
from face_clipper.tracking.face_tracker import FaceTracker
from face_clipper.types import CropWindow, FrameSize


class PortraitCropPipeline:
    """Coordinates detector, tracker, and crop planner."""

    def __init__(self, detector: FaceDetector, config: CropConfig | None = None) -> None:
        self.detector = detector
        self.config = config or CropConfig()
        self.tracker = FaceTracker(alpha=self.config.smoothing_alpha)

    def process_frame(self, frame: object, frame_size: FrameSize) -> CropWindow:
        faces = self.detector.detect(frame)
        if not faces:
            fallback_center_x = frame_size.width / 2
            return compute_portrait_crop(
                frame=frame_size,
                target_w=self.config.output_width,
                target_h=self.config.output_height,
                center_x=fallback_center_x,
            )

        center_x = self.tracker.update(faces[0])
        return compute_portrait_crop(
            frame=frame_size,
            target_w=self.config.output_width,
            target_h=self.config.output_height,
            center_x=center_x,
        )
