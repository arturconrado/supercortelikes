import statistics
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
    step = max(1, round(fps * sample_seconds))
    start_frame = max(0, round(start_seconds * fps))
    end_frame = round(end_seconds * fps) if end_seconds is not None else None
    if start_frame:
        capture.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    backend, detect = _detector(detector, cv2, settings)
    samples: List[Dict[str, Any]] = []
    frame_index = start_frame
    previous_gray = None
    try:
        while True:
            if end_frame is not None and frame_index > end_frame:
                break
            ok, frame = capture.read()
            if not ok:
                break
            if (frame_index - start_frame) % step == 0:
                boxes = detect(frame)
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                activity = _motion_activity(previous_gray, gray, boxes)
                boxes = [
                    (
                        box[0],
                        box[1],
                        box[2],
                        box[3],
                        box[4] * (1.0 + activity[index] * 2.0),
                    )
                    for index, box in enumerate(boxes)
                ]
                focus = _weighted_center(boxes, width, height)
                samples.append(
                    {
                        "time": round(frame_index / fps, 3),
                        "x": round(focus[0], 2),
                        "y": round(focus[1], 2),
                        "detections": len(boxes),
                        "activeSpeakerConfidence": round(
                            max(activity) if activity else 0.0, 4
                        ),
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
        "range": {"start": start_seconds, "end": end_seconds},
    }


def smart_crop_geometry(
    analysis: Dict[str, Any], aspect: str, max_height: int = 720
) -> Dict[str, int]:
    if aspect not in ASPECTS:
        raise WorkerError("INVALID_ASPECT_RATIO", "Unsupported smart reframe aspect ratio")
    width, height = int(analysis["width"]), int(analysis["height"])
    focus_x, focus_y = float(analysis["focus"]["x"]), float(analysis["focus"]["y"])
    ratio_width, ratio_height = ASPECTS[aspect]
    crop_width, crop_height = crop_dimensions(width, height, ratio_width, ratio_height)
    crop_x = even_coordinate(max(0, min(width - crop_width, focus_x - crop_width / 2)))
    crop_y = even_coordinate(max(0, min(height - crop_height, focus_y - crop_height / 2)))
    target_width, target_height = output_dimensions(ratio_width, ratio_height, max_height)
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
        geometry = smart_crop_geometry(analysis, aspect, settings.render_max_height)
        output = output_dir / ("reframe-%s.mp4" % aspect.replace(":", "x"))
        run_command(
            [
                settings.ffmpeg_binary,
                "-y",
                "-i",
                str(source),
                "-vf",
                "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos"
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

        def detect(frame: Any):
            result = model.predict(frame, verbose=False, classes=[0])[0]
            boxes = []
            for value in result.boxes:
                x1, y1, x2, y2 = value.xyxy[0].tolist()
                boxes.append((x1, y1, x2 - x1, y2 - y1, float(value.conf[0])))
            return boxes

        return "ultralytics-yolo-person", detect
    raise ValueError("Unsupported detector: %s" % name)
