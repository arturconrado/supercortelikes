from pathlib import Path
from types import SimpleNamespace

import media_worker.rendering as rendering
import media_worker.vision as vision
from media_worker.vision import crop_dimensions, even, output_dimensions, smart_crop_geometry


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
    assert video_filter.endswith("scale=720:1280:flags=lanczos,setsar=1")
