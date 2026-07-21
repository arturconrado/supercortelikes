from pathlib import Path

from media_worker.composition import (
    _combine_voice_activity,
    composition_plan,
    fallback_plan,
    smooth_keyframes,
)
from media_worker.rendering import _composition_filter_graph


def _box(x: int, activity: float):
    return {
        "x": x,
        "y": 180,
        "width": 280,
        "height": 420,
        "confidence": 0.95,
        "activity": activity,
    }


def test_composition_uses_fill_split_and_safe_fallbacks():
    clip = {"id": "clip-001", "start": 0, "end": 3}
    analysis = {
        "width": 1920,
        "height": 1080,
        "detectionRate": 1,
        "samples": [
            {"time": 0, "boxes": [_box(200, 1)], "activeSpeakerConfidence": 1},
            {"time": 0.75, "boxes": [_box(240, 1)], "activeSpeakerConfidence": 1},
            {"time": 1.5, "boxes": [_box(200, 0.1), _box(1200, 0.12)], "activeSpeakerConfidence": 0.12},
            {"time": 2.25, "boxes": [_box(220, 0.1), _box(1180, 0.12)], "activeSpeakerConfidence": 0.12},
        ],
    }
    plan = composition_plan(clip, analysis, aspect="9:16")
    assert [scene["layout"] for scene in plan["scenes"]] == ["fill", "split"]
    assert plan["diagnostics"]["status"] == "ready"
    assert all(scene["captionSafeZone"] == "bottom" for scene in plan["scenes"])

    low_confidence = {**analysis, "detectionRate": 0.2}
    assert composition_plan(clip, low_confidence, aspect="9:16")["scenes"][0]["layout"] == "fit"
    assert fallback_plan(clip, "9:16", "budget-exceeded")["diagnostics"]["reason"] == "budget-exceeded"


def test_voice_activity_gates_lip_motion_and_keyframes_never_jump_over_eight_percent():
    analysis = {
        "samples": [
            {"time": 0.05, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
            {"time": 0.5, "activeSpeakerConfidence": 1, "boxes": [{"activity": 1}]},
        ]
    }
    _combine_voice_activity(analysis, [{"start": 0, "end": 0.1}])
    assert analysis["samples"][0]["voiceActive"] is True
    assert analysis["samples"][1]["activeSpeakerConfidence"] == 0.2

    keyframes = smooth_keyframes(
        [
            {"time": 0, "focusX": 0, "focusY": 0, "confidence": 1},
            {"time": 0.25, "focusX": 1920, "focusY": 1080, "confidence": 1},
        ],
        1920,
        1080,
    )
    assert abs(keyframes[1]["x"] - keyframes[0]["x"]) <= 1920 * 0.08 + 0.01
    assert abs(keyframes[1]["y"] - keyframes[0]["y"]) <= 1080 * 0.08 + 0.01


def test_diarization_speaker_ids_are_associated_with_stable_visual_tracks():
    analysis = {
        "samples": [
            {
                "time": 0.1,
                "activeSpeakerConfidence": 0.9,
                "boxes": [_box(100, 0.9), _box(1100, 0.1)],
            },
            {
                "time": 0.6,
                "activeSpeakerConfidence": 0.8,
                "boxes": [_box(110, 0.8), _box(1090, 0.1)],
            },
            {
                "time": 1.1,
                "activeSpeakerConfidence": 0.9,
                "boxes": [_box(120, 0.1), _box(1080, 0.9)],
            },
        ]
    }
    _combine_voice_activity(
        analysis,
        [
            {"start": 0, "end": 0.8, "speaker": "SPEAKER_00"},
            {"start": 0.9, "end": 1.4, "speaker": "SPEAKER_01"},
        ],
    )

    assert analysis["speakerTrackMap"] == {"SPEAKER_00": 1, "SPEAKER_01": 2}
    assert analysis["samples"][0]["boxes"][0]["activity"] >= 0.85
    assert analysis["samples"][2]["boxes"][1]["activity"] >= 0.85


def test_ffmpeg_composition_has_dynamic_crop_transition_captions_brand_and_no_upscale(tmp_path: Path):
    plan = {
        "aspectRatio": "9:16",
        "source": {"width": 1920, "height": 1080},
        "scenes": [
            {
                "start": 0,
                "end": 1,
                "layout": "fill",
                "keyframes": [
                    {"time": 0, "x": 500, "y": 400},
                    {"time": 0.5, "x": 700, "y": 420},
                ],
                "subjects": [],
            },
            {"start": 1, "end": 2, "layout": "fit", "keyframes": [], "subjects": []},
        ],
    }
    graph, label = _composition_filter_graph(
        plan,
        {"id": "clip-001", "start": 0, "end": 2},
        {"ass": str(tmp_path / "caption.ass")},
        {"maxSourceShortSide": 1080, "watermarkText": "PicaShorts"},
        watermark=False,
    )
    assert "crop=606:1080:x='if(" in graph
    assert "scale=606:1076" in graph
    assert "xfade=transition=fade:duration=0.180" in graph
    assert graph.count("fps=30,settb=AVTB,format=yuv420p") == 2
    assert "ass='" in graph and "drawtext=text='PicaShorts'" in graph
    assert label == "branded"
