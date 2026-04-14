from face_clipper.types import CropWindow, FrameSize


def compute_portrait_crop(frame: FrameSize, target_w: int, target_h: int, center_x: float) -> CropWindow:
    """Compute horizontal crop window centered around tracked face center."""

    crop_w = min(frame.width, int(frame.height * target_w / target_h))
    crop_h = frame.height

    left = int(center_x - (crop_w / 2))
    if left < 0:
        left = 0
    if left + crop_w > frame.width:
        left = frame.width - crop_w

    return CropWindow(x=left, y=0, w=crop_w, h=crop_h)
