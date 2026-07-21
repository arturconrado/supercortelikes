import statistics
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .config import Settings
from .errors import DependencyUnavailable, WorkerError
from .memory import release_runtime_memory
from .process import run_command


ASPECTS = {"9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5), "16:9": (16, 9)}


def analyze_focus(
    path: Path,
    detector: str,
    settings: Settings,
    sample_seconds: float = 0.75,
    start_seconds: float = 0.0,
    end_seconds: Optional[float] = None,
    time_budget_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    try:
        import cv2
    except ImportError as error:
        raise DependencyUnavailable(
            "opencv", "OpenCV is required for smart reframe analysis"
        ) from error
    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise WorkerError("VIDEO_OPEN_FAILED", "OpenCV could not open the source video")
    fps = float(capture.get(cv2.CAP_PROP_FPS) or 25.0)
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    detection_step = max(1, round(fps * sample_seconds))
    tracking_step = max(1, round(detection_step / 2))
    start_frame = max(0, round(start_seconds * fps))
    end_frame = round(end_seconds * fps) if end_seconds is not None else None
    if start_frame:
        capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    backend, detect = _detector(detector, cv2, settings)
    samples: List[Dict[str, Any]] = []
    frame_index = start_frame
    previous_gray = None
    tracked_boxes: List[Tuple[float, float, float, float, float]] = []
    deadline = time.monotonic() + time_budget_seconds if time_budget_seconds else None
    try:
        while True:
            if deadline is not None and time.monotonic() > deadline:
                raise WorkerError("VISION_TIME_BUDGET_EXCEEDED", "Composition analysis exceeded its CPU time budget")
            if end_frame is not None and frame_index > end_frame:
                break
            ok, frame = capture.read()
            if not ok:
                break
            relative_frame = frame_index - start_frame
            if relative_frame % tracking_step == 0:
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                if relative_frame % detection_step == 0 or not tracked_boxes:
                    tracked_boxes = detect(frame)
                else:
                    tracked_boxes = _track_boxes(previous_gray, gray, tracked_boxes, cv2)
                boxes = tracked_boxes
                # A single detected face is unambiguous. Lip-region motion is only
                # needed to disambiguate interviews and remote grids.
                activity_regions = getattr(detect, "activity_regions", None)
                regions = (
                    activity_regions(frame, boxes)
                    if len(boxes) > 1 and callable(activity_regions)
                    else boxes
                )
                activity = (
                    _motion_activity(previous_gray, gray, regions)
                    if len(boxes) > 1
                    else [1.0 for _ in boxes]
                )
                weighted_boxes = [
                    (
                        box[0],
                        box[1],
                        box[2],
                        box[3],
                        box[4] * (1.0 + activity[index] * 2.0),
                    )
                    for index, box in enumerate(boxes)
                ]
                focus = _weighted_center(weighted_boxes, width, height)
                samples.append(
                    {
                        "time": round(frame_index / fps, 3),
                        "x": round(focus[0], 2),
                        "y": round(focus[1], 2),
                        "detections": len(weighted_boxes),
                        "activeSpeakerConfidence": round(
                            max(activity) if activity else 0.0, 4
                        ),
                        "boxes": [
                            {
                                "x": round(float(box[0]), 2),
                                "y": round(float(box[1]), 2),
                                "width": round(float(box[2]), 2),
                                "height": round(float(box[3]), 2),
                                "confidence": round(float(box[4]), 4),
                                "activity": round(float(activity[index]), 4),
                            }
                            for index, box in enumerate(weighted_boxes)
                        ],
                    }
                )
                previous_gray = gray
            frame_index += 1
    finally:
        capture.release()
        cleanup = getattr(detect, "close", None)
        if callable(cleanup):
            cleanup()
        release_runtime_memory()
    if not samples:
        raise WorkerError(
            "VISION_NO_FRAMES", "No video frames were available for smart reframe"
        )
    detected = [sample for sample in samples if sample["detections"] > 0]
    usable = detected or samples
    return {
        "backend": backend,
        "width": width,
        "height": height,
        "samples": samples,
        "focus": {
            "x": round(statistics.median(sample["x"] for sample in usable), 2),
            "y": round(statistics.median(sample["y"] for sample in usable), 2),
        },
        "detectionRate": round(len(detected) / len(samples), 4),
        "activeSpeakerMethod": "face-region-motion",
        "detectionFps": round(fps / detection_step, 3),
        "trackingFps": round(fps / tracking_step, 3),
        "range": {"start": start_seconds, "end": end_seconds},
    }


def smart_crop_geometry(
    analysis: Dict[str, Any],
    aspect: str,
    max_height: int = 720,
    preserve_source_quality: bool = False,
) -> Dict[str, int]:
    if aspect not in ASPECTS:
        raise WorkerError("INVALID_ASPECT_RATIO", "Unsupported smart reframe aspect ratio")
    width, height = int(analysis["width"]), int(analysis["height"])
    focus_x, focus_y = float(analysis["focus"]["x"]), float(analysis["focus"]["y"])
    ratio_width, ratio_height = ASPECTS[aspect]
    crop_width, crop_height = crop_dimensions(width, height, ratio_width, ratio_height)
    crop_x = even_coordinate(max(0, min(width - crop_width, focus_x - crop_width / 2)))
    crop_y = even_coordinate(max(0, min(height - crop_height, focus_y - crop_height / 2)))
    output_base = (
        source_quality_base(width, height, max_height)
        if preserve_source_quality
        else max_height
    )
    target_width, target_height = output_dimensions(ratio_width, ratio_height, output_base)
    return {
        "x": crop_x,
        "y": crop_y,
        "width": crop_width,
        "height": crop_height,
        "targetWidth": target_width,
        "targetHeight": target_height,
    }


def render_reframes(
    source: Path,
    analysis: Dict[str, Any],
    aspect_ratios: Sequence[str],
    output_dir: Path,
    settings: Settings,
) -> List[Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for aspect in aspect_ratios:
        geometry = smart_crop_geometry(
            analysis,
            aspect,
            settings.render_max_source_short_side,
            preserve_source_quality=True,
        )
        output = output_dir / ("reframe-%s.mp4" % aspect.replace(":", "x"))
        run_command(
            [
                settings.ffmpeg_binary,
                "-y",
                "-i",
                str(source),
                "-vf",
                "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos,setsar=1"
                % (
                    geometry["width"],
                    geometry["height"],
                    geometry["x"],
                    geometry["y"],
                    geometry["targetWidth"],
                    geometry["targetHeight"],
                ),
                "-c:v",
                "libx264",
                "-preset",
                settings.ffmpeg_preset,
                "-crf",
                str(settings.ffmpeg_crf),
                "-threads",
                str(settings.ffmpeg_threads),
                "-filter_threads",
                str(settings.ffmpeg_filter_threads),
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(output),
            ],
            timeout=7200,
        )
        outputs.append(output)
    return outputs


def crop_dimensions(
    width: int, height: int, ratio_width: int, ratio_height: int
) -> Tuple[int, int]:
    desired = ratio_width / ratio_height
    current = width / height
    if current > desired:
        return even(height * desired), even(height)
    return even(width), even(width / desired)


def output_dimensions(ratio_width: int, ratio_height: int, base: int = 720) -> Tuple[int, int]:
    if ratio_width / ratio_height < 1:
        return even(base), even(base * ratio_height / ratio_width)
    return even(base * ratio_width / ratio_height), even(base)


def source_quality_base(width: int, height: int, max_short_side: int = 2160) -> int:
    """Preserve source detail without upscaling past the configured ceiling."""
    return even(min(width, height, max(360, min(2160, max_short_side))))


def even(value: float) -> int:
    return max(2, int(value) // 2 * 2)


def even_coordinate(value: float) -> int:
    return max(0, int(value) // 2 * 2)


def _weighted_center(
    boxes: Sequence[Tuple[float, float, float, float, float]], width: int, height: int
) -> Tuple[float, float]:
    if not boxes:
        return width / 2, height / 2
    total = sum(max(0.01, box[4]) * max(1.0, box[2] * box[3]) for box in boxes)
    x = (
        sum(
            (box[0] + box[2] / 2) * max(0.01, box[4]) * max(1.0, box[2] * box[3])
            for box in boxes
        )
        / total
    )
    y = (
        sum(
            (box[1] + box[3] / 2) * max(0.01, box[4]) * max(1.0, box[2] * box[3])
            for box in boxes
        )
        / total
    )
    return x, y


def _motion_activity(
    previous_gray: Any,
    current_gray: Any,
    boxes: Sequence[Tuple[float, float, float, float, float]],
) -> List[float]:
    if previous_gray is None or previous_gray.shape != current_gray.shape:
        return [0.0 for _ in boxes]
    try:
        import cv2
    except ImportError:
        return [0.0 for _ in boxes]
    difference = cv2.absdiff(previous_gray, current_gray)
    height, width = current_gray.shape[:2]
    values = []
    for x, y, box_width, box_height, _ in boxes:
        left = max(0, int(x))
        right = min(width, int(x + box_width))
        # Mouth and hands produce stronger short-term motion than a static torso.
        top = max(0, int(y + box_height * 0.45))
        bottom = min(height, int(y + box_height))
        region = difference[top:bottom, left:right]
        values.append(min(1.0, float(region.mean()) / 32.0) if region.size else 0.0)
    return values


def _track_boxes(previous_gray: Any, current_gray: Any, boxes: Sequence[Tuple[float, float, float, float, float]], cv2: Any):
    if previous_gray is None or previous_gray.shape != current_gray.shape:
        return list(boxes)
    try:
        import numpy as np
    except ImportError:
        return list(boxes)
    height, width = current_gray.shape[:2]
    tracked = []
    for x, y, box_width, box_height, confidence in boxes:
        mask = np.zeros_like(previous_gray)
        left, top = max(0, int(x)), max(0, int(y))
        right, bottom = min(width, int(x + box_width)), min(height, int(y + box_height))
        mask[top:bottom, left:right] = 255
        points = cv2.goodFeaturesToTrack(previous_gray, mask=mask, maxCorners=24, qualityLevel=0.02, minDistance=5)
        if points is None:
            tracked.append((x, y, box_width, box_height, confidence * 0.9))
            continue
        next_points, status, _error = cv2.calcOpticalFlowPyrLK(previous_gray, current_gray, points, None)
        if next_points is None or status is None:
            tracked.append((x, y, box_width, box_height, confidence * 0.9))
            continue
        valid = status.reshape(-1) == 1
        if not valid.any():
            tracked.append((x, y, box_width, box_height, confidence * 0.9))
            continue
        shifts = next_points.reshape(-1, 2)[valid] - points.reshape(-1, 2)[valid]
        dx, dy = float(np.median(shifts[:, 0])), float(np.median(shifts[:, 1]))
        tracked.append(
            (
                max(0.0, min(width - box_width, x + dx)),
                max(0.0, min(height - box_height, y + dy)),
                box_width,
                box_height,
                confidence * 0.97,
            )
        )
    return tracked


def _detector(name: str, cv2: Any, settings: Settings):
    if name == "auto":
        for candidate in ("opencv", "mediapipe", "yolo"):
            try:
                return _detector(candidate, cv2, settings)
            except DependencyUnavailable:
                continue
        raise DependencyUnavailable(
            "vision", "No MediaPipe, YOLO, or OpenCV detector is available"
        )
    if name == "opencv":
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        cascade = cv2.CascadeClassifier(cascade_path)
        if cascade.empty():
            raise DependencyUnavailable(
                "opencv-haar", "OpenCV face cascade could not be loaded"
            )

        def detect(frame: Any):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(
                gray, scaleFactor=1.1, minNeighbors=5, minSize=(40, 40)
            )
            return [
                (float(x), float(y), float(w), float(h), 1.0) for x, y, w, h in faces
            ]

        return "opencv-haar-face", detect
    if name == "mediapipe":
        try:
            import mediapipe as mp
        except ImportError as error:
            raise DependencyUnavailable(
                "mediapipe", "MediaPipe is not installed"
            ) from error
        face_detector = mp.solutions.face_detection.FaceDetection(
            model_selection=1, min_detection_confidence=0.5
        )
        hand_detector = mp.solutions.hands.Hands(
            static_image_mode=True, max_num_hands=4, min_detection_confidence=0.45
        )

        def detect(frame: Any):
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            height, width = frame.shape[:2]
            boxes = []
            face_result = face_detector.process(rgb)
            for value in face_result.detections or []:
                box = value.location_data.relative_bounding_box
                boxes.append(
                    (
                        box.xmin * width,
                        box.ymin * height,
                        box.width * width,
                        box.height * height,
                        float(value.score[0]) * 2,
                    )
                )
            hands = hand_detector.process(rgb)
            for landmarks in hands.multi_hand_landmarks or []:
                xs = [point.x * width for point in landmarks.landmark]
                ys = [point.y * height for point in landmarks.landmark]
                boxes.append(
                    (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys), 0.45)
                )
            return boxes

        def close():
            face_detector.close()
            hand_detector.close()

        setattr(detect, "close", close)
        return "mediapipe-face-hands", detect
    if name == "yolo":
        try:
            from ultralytics import YOLO
        except ImportError as error:
            raise DependencyUnavailable(
                "ultralytics", "Ultralytics YOLO is not installed"
            ) from error
        model = YOLO(settings.yolo_model)
        face_mesh = None
        try:
            import mediapipe as mp

            face_mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=4,
                refine_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
        except (ImportError, AttributeError):
            face_mesh = None

        def detect(frame: Any):
            result = model.track(
                frame,
                persist=True,
                tracker="bytetrack.yaml",
                verbose=False,
                classes=[0],
                device=0 if settings.media_accelerator == "cuda" else "cpu",
            )[0]
            boxes = []
            for value in result.boxes:
                x1, y1, x2, y2 = value.xyxy[0].tolist()
                boxes.append((x1, y1, x2 - x1, y2 - y1, float(value.conf[0])))
            return boxes

        def activity_regions(
            frame: Any,
            people: Sequence[Tuple[float, float, float, float, float]],
        ):
            if face_mesh is None:
                return people
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            height, width = frame.shape[:2]
            result = face_mesh.process(rgb)
            mouth_regions = []
            for face in result.multi_face_landmarks or []:
                points = [
                    face.landmark[index] for index in (13, 14, 61, 78, 291, 308)
                ]
                xs = [point.x * width for point in points]
                ys = [point.y * height for point in points]
                pad_x = max(4.0, (max(xs) - min(xs)) * 0.35)
                pad_y = max(4.0, (max(ys) - min(ys)) * 1.1)
                left = max(0.0, min(xs) - pad_x)
                top = max(0.0, min(ys) - pad_y)
                right = min(float(width), max(xs) + pad_x)
                bottom = min(float(height), max(ys) + pad_y)
                mouth_regions.append(
                    (left, top, right - left, bottom - top, 1.0)
                )
            regions = []
            for person in people:
                px, py, pw, ph, confidence = person
                matches = [
                    mouth
                    for mouth in mouth_regions
                    if px <= mouth[0] + mouth[2] / 2 <= px + pw
                    and py <= mouth[1] + mouth[3] / 2 <= py + ph
                ]
                regions.append(
                    matches[0]
                    if matches
                    else (px, py, pw, ph * 0.45, confidence)
                )
            return regions

        def close():
            if face_mesh is not None:
                face_mesh.close()

        setattr(detect, "activity_regions", activity_regions)
        setattr(detect, "close", close)
        return "ultralytics-yolo-bytetrack-mediapipe-mouth", detect
    raise ValueError("Unsupported detector: %s" % name)
