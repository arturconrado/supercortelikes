import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import media_worker.rendering as rendering
import media_worker.vision as vision
from media_worker.vision import (
    crop_dimensions,
    even,
    frame_timestamp,
    output_dimensions,
    smart_crop_geometry,
    source_quality_base,
)


def test_frame_timestamp_prefers_real_pts_for_vfr_and_remains_monotonic():
    assert frame_timestamp(
        1_137.5,
        frame_index=25,
        fps=25,
        last_timestamp=1.0,
    ) == 1.1375
    assert frame_timestamp(
        0,
        frame_index=26,
        fps=25,
        last_timestamp=1.1375,
    ) > 1.1375


def test_crop_dimensions_preserve_requested_ratio_inside_source():
    assert crop_dimensions(1920, 1080, 9, 16) == (606, 1080)
    assert crop_dimensions(1080, 1920, 1, 1) == (1080, 1080)
    width, height = output_dimensions(4, 5)
    assert width == 720
    assert height == 900
    assert width % 2 == 0 and height % 2 == 0


def test_even_never_returns_odd_or_zero():
    assert even(0) == 2
    assert even(607) == 606


def test_smart_crop_geometry_targets_only_the_requested_output_ratio():
    geometry = smart_crop_geometry(
        {"width": 1920, "height": 1080, "focus": {"x": 1500, "y": 540}},
        "9:16",
        720,
    )
    assert geometry == {
        "x": 1196,
        "y": 0,
        "width": 606,
        "height": 1080,
        "targetWidth": 720,
        "targetHeight": 1280,
    }


def test_source_quality_base_preserves_the_source_tier_with_a_4k_ceiling():
    assert source_quality_base(640, 360) == 360
    assert source_quality_base(1280, 720) == 720
    assert source_quality_base(1920, 1080) == 1080
    assert source_quality_base(3840, 2160) == 2160
    assert source_quality_base(7680, 4320) == 2160
    assert source_quality_base(1920, 1080, 720) == 720


def test_smart_crop_geometry_preserves_1080p_source_quality():
    geometry = smart_crop_geometry(
        {"width": 1920, "height": 1080, "focus": {"x": 960, "y": 540}},
        "9:16",
        2160,
        preserve_source_quality=True,
    )
    assert (geometry["targetWidth"], geometry["targetHeight"]) == (1080, 1920)


def test_render_clips_forces_square_pixels(monkeypatch, tmp_path: Path):
    commands = []
    monkeypatch.setattr(rendering, "run_command", lambda command, timeout: commands.append(command))
    settings = SimpleNamespace(
        ffmpeg_binary="ffmpeg",
        ffmpeg_threads=2,
        ffmpeg_filter_threads=1,
        ffmpeg_preset="veryfast",
        ffmpeg_crf=23,
    )

    rendering.render_clips(
        tmp_path / "source.mp4",
        [{"id": "clip", "start": 0, "end": 1}],
        [],
        tmp_path / "renders",
        settings,
        {
            "smartCrop": {
                "width": 606,
                "height": 1080,
                "x": 0,
                "y": 0,
                "targetWidth": 720,
                "targetHeight": 1280,
            }
        },
    )

    command = commands[0]
    video_filter = command[command.index("-vf") + 1]
    assert video_filter == "setpts=PTS-STARTPTS,crop=606:1080:0:0,scale=720:1280:flags=lanczos,setsar=1"
    assert command[command.index("-af") + 1].startswith("aresample=async=1:first_pts=0,")
    assert "-shortest" in command


def test_render_reframes_forces_square_pixels(monkeypatch, tmp_path: Path):
    commands = []
    monkeypatch.setattr(vision, "run_command", lambda command, timeout: commands.append(command))
    settings = SimpleNamespace(
        ffmpeg_binary="ffmpeg",
        ffmpeg_threads=2,
        ffmpeg_filter_threads=1,
        ffmpeg_preset="veryfast",
        ffmpeg_crf=23,
        render_max_height=720,
        render_max_source_short_side=2160,
    )

    vision.render_reframes(
        tmp_path / "source.mp4",
        {"width": 1920, "height": 1080, "focus": {"x": 960, "y": 540}},
        ["9:16"],
        tmp_path / "reframes",
        settings,
    )

    command = commands[0]
    video_filter = command[command.index("-vf") + 1]
    assert video_filter.endswith("scale=1080:1920:flags=lanczos,setsar=1")


def test_yolo_detection_does_not_require_bytetrack_lap(monkeypatch):
    calls = []

    class FakeModel:
        def __init__(self, model):
            assert model == "yolo11n.pt"

        def predict(self, frame, **options):
            calls.append(options)
            box = SimpleNamespace(
                xyxy=[SimpleNamespace(tolist=lambda: [10, 20, 110, 220])],
                conf=[0.9],
            )
            return [SimpleNamespace(boxes=[box])]

    module = ModuleType("ultralytics")
    module.YOLO = FakeModel
    monkeypatch.setitem(sys.modules, "ultralytics", module)
    monkeypatch.setitem(sys.modules, "mediapipe", None)

    _backend, detect = vision._detector(
        "yolo",
        SimpleNamespace(),
        SimpleNamespace(yolo_model="yolo11n.pt", media_accelerator="cpu"),
    )

    assert detect(object()) == [(10, 20, 100, 200, 0.9)]
    assert calls == [{"verbose": False, "classes": [0], "device": "cpu"}]


def _fake_mediapipe_module(detections):
    class FakeFaceDetection:
        def __init__(self, **_kwargs):
            pass

        def process(self, _rgb):
            return SimpleNamespace(detections=detections)

        def close(self):
            pass

    module = ModuleType("mediapipe")
    module.solutions = SimpleNamespace(
        face_detection=SimpleNamespace(FaceDetection=FakeFaceDetection)
    )
    return module


def test_mediapipe_detection_extracts_mouth_region_activity_from_keypoints(monkeypatch):
    keypoints = [
        SimpleNamespace(x=0.3, y=0.3),  # right eye
        SimpleNamespace(x=0.4, y=0.3),  # left eye
        SimpleNamespace(x=0.35, y=0.35),  # nose tip
        SimpleNamespace(x=0.35, y=0.45),  # mouth center (index 3)
        SimpleNamespace(x=0.25, y=0.32),  # right ear tragion
        SimpleNamespace(x=0.45, y=0.32),  # left ear tragion
    ]
    detection = SimpleNamespace(
        location_data=SimpleNamespace(
            relative_bounding_box=SimpleNamespace(
                xmin=0.2, ymin=0.2, width=0.3, height=0.4
            ),
            relative_keypoints=keypoints,
        ),
        score=[0.9],
    )
    monkeypatch.setitem(sys.modules, "mediapipe", _fake_mediapipe_module([detection]))
    cv2_stub = SimpleNamespace(cvtColor=lambda frame, _code: frame, COLOR_BGR2RGB=1)

    _backend, detect = vision._detector("mediapipe", cv2_stub, SimpleNamespace())
    frame = SimpleNamespace(shape=(1000, 1000, 3))
    boxes = detect(frame)
    assert boxes == [(200.0, 200.0, 300.0, 400.0, 1.8)]

    activity_regions = getattr(detect, "activity_regions", None)
    assert callable(activity_regions)
    regions = activity_regions(frame, boxes)
    assert len(regions) == 1
    region = regions[0]
    # Region should be a small crop centered on the mouth keypoint, not the
    # full face box.
    assert region != boxes[0]
    region_center_x = region[0] + region[2] / 2
    region_center_y = region[1] + region[3] / 2
    assert abs(region_center_x - 350) < 1
    assert abs(region_center_y - 450) < 1


def test_mediapipe_activity_regions_falls_back_to_full_face_box_without_enough_keypoints(
    monkeypatch,
):
    detection = SimpleNamespace(
        location_data=SimpleNamespace(
            relative_bounding_box=SimpleNamespace(
                xmin=0.2, ymin=0.2, width=0.3, height=0.4
            ),
            relative_keypoints=[SimpleNamespace(x=0.3, y=0.3)],  # only 1, <= 3
        ),
        score=[0.9],
    )
    monkeypatch.setitem(sys.modules, "mediapipe", _fake_mediapipe_module([detection]))
    cv2_stub = SimpleNamespace(cvtColor=lambda frame, _code: frame, COLOR_BGR2RGB=1)

    _backend, detect = vision._detector("mediapipe", cv2_stub, SimpleNamespace())
    frame = SimpleNamespace(shape=(1000, 1000, 3))
    boxes = detect(frame)

    activity_regions = getattr(detect, "activity_regions")
    # Unlike YOLO's `ph * 0.45` fallback (a full-body person box), a mediapipe
    # face box is already tight, so an unmatched face falls back to the full
    # box rather than a further crop.
    assert activity_regions(frame, boxes) == boxes


def test_resolve_activity_regions_skips_the_extra_detector_pass_when_requested():
    calls = []

    def fake_activity_regions(_frame, boxes):
        calls.append(boxes)
        return ["refined-region"]

    detect = lambda _frame: []  # noqa: E731 - detect() itself is unused here
    detect.activity_regions = fake_activity_regions
    boxes = [(0, 0, 10, 10, 0.9), (20, 20, 10, 10, 0.8)]

    skipped = vision._resolve_activity_regions(detect, object(), boxes, True)
    assert skipped == boxes
    assert calls == []

    refined = vision._resolve_activity_regions(detect, object(), boxes, False)
    assert refined == ["refined-region"]
    assert calls == [boxes]

    # A single box is unambiguous regardless of the flag -- never refined.
    single = [(0, 0, 10, 10, 0.9)]
    assert vision._resolve_activity_regions(detect, object(), single, False) == single
    assert calls == [boxes]
