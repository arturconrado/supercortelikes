from pathlib import Path
from types import SimpleNamespace

import media_worker.rendering as rendering
import media_worker.vision as vision
from media_worker.vision import (
    crop_dimensions,
    even,
    output_dimensions,
    smart_crop_geometry,
    source_quality_base,
)


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
    assert video_filter == "crop=606:1080:0:0,scale=720:1280:flags=lanczos,setsar=1"


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
