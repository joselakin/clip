# Face Detection Module (Python)

This module is prepared for portrait clipping from landscape video using face-aware crop planning.

## Goals
- Detect faces frame-by-frame (or sampled frames).
- Track face position over time.
- Generate a stable crop window for portrait output (9:16 by default).
- Provide a pipeline that can be integrated with FFmpeg processing.

## Folder Architecture
- `src/face_clipper/`: main package.
- `src/face_clipper/detectors/`: detector interfaces and implementations.
- `src/face_clipper/tracking/`: temporal smoothing/tracking logic.
- `src/face_clipper/planning/`: crop window planning logic.
- `src/face_clipper/pipeline/`: end-to-end orchestration.
- `tests/`: basic test and import checks.

## Next Implementation Steps
1. Replace mock detector with OpenCV/MediaPipe detector.
2. Feed detector output into tracker smoothing.
3. Export crop coordinates to FFmpeg filter arguments.
4. Add benchmark and accuracy tests.
