import argparse

from face_clipper.config import CropConfig
from face_clipper.detectors.mock_detector import MockFaceDetector
from face_clipper.pipeline.portrait_pipeline import PortraitCropPipeline
from face_clipper.types import FrameSize


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Face-aware portrait crop planning scaffold")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    return parser


def main() -> None:
    args = build_parser().parse_args()

    pipeline = PortraitCropPipeline(detector=MockFaceDetector(), config=CropConfig())
    window = pipeline.process_frame(frame=None, frame_size=FrameSize(width=args.width, height=args.height))

    print(f"Planned crop window: x={window.x}, y={window.y}, w={window.w}, h={window.h}")


if __name__ == "__main__":
    main()
