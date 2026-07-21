from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from .config import Settings
from .errors import ArtifactMissing, WorkerError
from .process import run_command
from .vision import crop_dimensions, output_dimensions, source_quality_base


def render_clips(
    source: Path,
    clips: Sequence[Mapping[str, Any]],
    caption_manifest: Sequence[Mapping[str, Any]],
    output_dir: Path,
    settings: Settings,
    options: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    captions = {value["clipId"]: value for value in caption_manifest}
    watermark = options.get("watermarkPath")
    watermark_text = str(options.get("watermarkText") or "").strip()
    if watermark and not Path(str(watermark)).is_file():
        raise ArtifactMissing(str(watermark))
    results = []
    for clip in clips:
        start = float(clip["start"])
        duration = float(clip["end"]) - start
        if duration <= 0:
            raise WorkerError(
                "INVALID_CLIP_DURATION",
                "Clip %s has a non-positive duration" % clip["id"],
            )
        caption = captions.get(clip["id"])
        output = output_dir / (str(clip["id"]) + ".mp4")
        command = [
            settings.ffmpeg_binary,
            "-y",
            "-ss",
            "%.3f" % start,
            "-t",
            "%.3f" % duration,
            "-i",
            str(source),
        ]
        filters = []
        composition_plans = options.get("compositionPlans")
        composition = (
            composition_plans.get(str(clip["id"]))
            if isinstance(composition_plans, Mapping)
            else None
        )
        smart_crops = options.get("smartCrops")
        smart_crop_value = (
            smart_crops.get(str(clip["id"]))
            if isinstance(smart_crops, Mapping)
            else options.get("smartCrop")
        )
        smart_crop = _smart_crop_filter(smart_crop_value)
        if smart_crop and not composition:
            filters.append(smart_crop)
        # FFmpeg preserves the display aspect ratio of the even-sized source crop by
        # changing SAR during scale. Social exports must use square pixels so that a
        # coded 720x1280 frame is also displayed as exactly 9:16 by browsers/players.
        filters.append("setsar=1")
        if caption and not composition:
            filters.append("ass='%s'" % _filter_escape(Path(str(caption["ass"]))))
        if watermark_text:
            position = _watermark_text_position(
                str(options.get("watermarkTextPosition", "w-tw-32:h-th-32"))
            )
            opacity = max(0.1, min(1.0, float(options.get("watermarkTextOpacity", 0.75))))
            filters.append(
                "drawtext=text='%s':x=%s:y=%s:fontsize=%d:fontcolor=white@%.2f:box=1:boxcolor=black@0.45:boxborderw=16"
                % (
                    _drawtext_escape(watermark_text),
                    position[0],
                    position[1],
                    int(options.get("watermarkTextSize", 42)),
                    opacity,
                )
            )
        if composition:
            if watermark:
                command.extend(["-i", str(watermark)])
            graph, output_label = _composition_filter_graph(
                composition,
                clip,
                caption,
                options,
                watermark=bool(watermark),
            )
            if watermark:
                position = str(options.get("watermarkPosition", "W-w-32:H-h-32"))
                if position not in {"32:32", "W-w-32:32", "32:H-h-32", "W-w-32:H-h-32"}:
                    raise WorkerError(
                        "INVALID_WATERMARK_POSITION", "Unsupported watermark position"
                    )
                opacity = max(0.1, min(1.0, float(options.get("watermarkOpacity", 0.85))))
                logo_width = max(48, min(420, int(options.get("watermarkLogoWidth", 180))))
                graph += (
                    ";[1:v]format=rgba,scale='min(%d,iw)':-1,colorchannelmixer=aa=%.2f[wm]"
                    ";[%s][wm]overlay=%s[rendered]"
                    % (logo_width, opacity, output_label, position)
                )
                output_label = "rendered"
            filter_script = output_dir / (str(clip["id"]) + ".filter")
            filter_script.write_text(graph, encoding="utf-8")
            command.extend(
                [
                    "-filter_complex_script",
                    str(filter_script),
                    "-map",
                    "[%s]" % output_label,
                    "-map",
                    "0:a?",
                ]
            )
        elif watermark:
            command.extend(["-i", str(watermark)])
            position = str(options.get("watermarkPosition", "W-w-32:H-h-32"))
            if position not in {"32:32", "W-w-32:32", "32:H-h-32", "W-w-32:H-h-32"}:
                raise WorkerError(
                    "INVALID_WATERMARK_POSITION", "Unsupported watermark position"
                )
            opacity = max(0.1, min(1.0, float(options.get("watermarkOpacity", 0.85))))
            logo_width = max(48, min(420, int(options.get("watermarkLogoWidth", 180))))
            video_chain = ",".join(filters) if filters else "null"
            command.extend(
                [
                    "-filter_complex",
                    "[0:v]%s[base];[1:v]format=rgba,scale='min(%d,iw)':-1,colorchannelmixer=aa=%.2f[wm];[base][wm]overlay=%s[v]"
                    % (video_chain, logo_width, opacity, position),
                    "-map",
                    "[v]",
                    "-map",
                    "0:a?",
                ]
            )
        elif filters:
            command.extend(["-vf", ",".join(filters)])
        command.extend(
            [
                "-threads",
                str(settings.ffmpeg_threads),
                "-filter_threads",
                str(settings.ffmpeg_filter_threads),
                "-c:v",
                "h264_nvenc" if getattr(settings, "media_accelerator", "cpu") == "cuda" else "libx264",
                "-preset",
                str(options.get("nvencPreset", "p6"))
                if getattr(settings, "media_accelerator", "cpu") == "cuda"
                else str(options.get("preset", settings.ffmpeg_preset)),
                *(
                    ["-cq", str(int(options.get("cq", 19))), "-b:v", "0"]
                    if getattr(settings, "media_accelerator", "cpu") == "cuda"
                    else ["-crf", str(int(options.get("crf", settings.ffmpeg_crf)))]
                ),
                "-c:a",
                "aac",
                "-profile:v",
                "high",
                "-fpsmax",
                "30",
                "-b:a",
                "192k",
                "-af",
                "loudnorm=I=-14:LRA=11:TP=-1.5",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                str(output),
            ]
        )
        run_command(command, timeout=int(options.get("timeoutSeconds", 7200)))
        results.append(
            {
                "clipId": clip["id"],
                "path": str(output),
                "durationSeconds": round(duration, 3),
            }
        )
    return results


def _composition_filter_graph(
    plan: Mapping[str, Any],
    clip: Mapping[str, Any],
    caption: Any,
    options: Mapping[str, Any],
    *,
    watermark: bool,
) -> tuple[str, str]:
    source = plan.get("source") if isinstance(plan.get("source"), Mapping) else {}
    source_width = max(2, int(source.get("width") or 1920))
    source_height = max(2, int(source.get("height") or 1080))
    aspect = str(options.get("aspectRatio") or plan.get("aspectRatio") or "9:16")
    ratios = {"9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5), "16:9": (16, 9)}
    if aspect not in ratios:
        raise WorkerError("INVALID_ASPECT_RATIO", "Unsupported composition aspect ratio")
    ratio_width, ratio_height = ratios[aspect]
    max_short_side = max(360, min(1080, int(options.get("maxSourceShortSide", 1080))))
    base = source_quality_base(source_width, source_height, max_short_side)
    safe_crop_width, safe_crop_height = crop_dimensions(
        source_width, source_height, ratio_width, ratio_height
    )
    base = min(
        base,
        safe_crop_width if ratio_width / ratio_height < 1 else safe_crop_height,
    )
    target_width, target_height = output_dimensions(ratio_width, ratio_height, base)
    clip_start, clip_end = float(clip["start"]), float(clip["end"])
    raw_scenes = plan.get("scenes") if isinstance(plan.get("scenes"), list) else []
    scenes = []
    for value in raw_scenes:
        if not isinstance(value, Mapping):
            continue
        start = max(clip_start, float(value.get("start", clip_start)))
        end = min(clip_end, float(value.get("end", clip_end)))
        if end > start:
            scenes.append((value, start, end))
    if not scenes:
        scenes = [({"layout": "fit", "keyframes": [], "subjects": []}, clip_start, clip_end)]

    transitions = [
        min(0.18, (scenes[index][2] - scenes[index][1]) / 2, (scenes[index + 1][2] - scenes[index + 1][1]) / 2)
        for index in range(max(0, len(scenes) - 1))
    ]

    graph: List[str] = []
    labels: List[str] = []
    scene_durations: List[float] = []
    for index, (scene, start, end) in enumerate(scenes):
        render_start = max(clip_start, start - (transitions[index - 1] / 2 if index > 0 else 0.0))
        render_end = min(clip_end, end + (transitions[index] / 2 if index < len(transitions) else 0.0))
        local_start, local_end = render_start - clip_start, render_end - clip_start
        scene_durations.append(render_end - render_start)
        layout = str(scene.get("layout", "fit"))
        label = "scene%d" % index
        if layout == "fill":
            crop_width, crop_height = crop_dimensions(
                source_width, source_height, ratio_width, ratio_height
            )
            keyframes = scene.get("keyframes") if isinstance(scene.get("keyframes"), list) else []
            x_values, y_values = _crop_keyframes(
                keyframes,
                render_start,
                source_width,
                source_height,
                crop_width,
                crop_height,
            )
            graph.append(
                "[0:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS,"
                "crop=%d:%d:x='%s':y='%s',scale=%d:%d:flags=lanczos,setsar=1,fps=30,settb=AVTB,format=yuv420p[%s]"
                % (
                    local_start,
                    local_end,
                    crop_width,
                    crop_height,
                    _piecewise_expression(x_values),
                    _piecewise_expression(y_values),
                    target_width,
                    target_height,
                    label,
                )
            )
        elif layout == "split" and len(scene.get("subjects") or []) >= 2:
            subjects = list(scene.get("subjects") or [])[:2]
            top_height = max(2, target_height // 2 // 2 * 2)
            bottom_height = max(2, target_height - top_height)
            top_crop_width, top_crop_height = crop_dimensions(
                source_width, source_height, target_width, top_height
            )
            bottom_crop_width, bottom_crop_height = crop_dimensions(
                source_width, source_height, target_width, bottom_height
            )
            first_x, first_y = _subject_crop(
                subjects[0], source_width, source_height, top_crop_width, top_crop_height
            )
            second_x, second_y = _subject_crop(
                subjects[1], source_width, source_height, bottom_crop_width, bottom_crop_height
            )
            graph.extend(
                [
                    "[0:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS,split=2[s%da][s%db]"
                    % (local_start, local_end, index, index),
                    "[s%da]crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos[top%d]"
                    % (index, top_crop_width, top_crop_height, first_x, first_y, target_width, top_height, index),
                    "[s%db]crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos[bottom%d]"
                    % (index, bottom_crop_width, bottom_crop_height, second_x, second_y, target_width, bottom_height, index),
                    "[top%d][bottom%d]vstack=inputs=2,setsar=1,fps=30,settb=AVTB,format=yuv420p[%s]"
                    % (index, index, label),
                ]
            )
        else:
            graph.extend(
                [
                    "[0:v]trim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS,split=2[f%dbg][f%dfg]"
                    % (local_start, local_end, index, index),
                    "[f%dbg]scale=%d:%d:force_original_aspect_ratio=increase:flags=lanczos,crop=%d:%d,boxblur=20:2[bg%d]"
                    % (index, target_width, target_height, target_width, target_height, index),
                    "[f%dfg]scale=%d:%d:force_original_aspect_ratio=decrease:flags=lanczos[fg%d]"
                    % (index, target_width, target_height, index),
                    "[bg%d][fg%d]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,settb=AVTB,format=yuv420p[%s]"
                    % (index, index, label),
                ]
            )
        labels.append(label)

    current = labels[0]
    current_duration = scene_durations[0]
    for index, label in enumerate(labels[1:], 1):
        transition = transitions[index - 1]
        output = "xfade%d" % index
        graph.append(
            "[%s][%s]xfade=transition=fade:duration=%.3f:offset=%.3f[%s]"
            % (current, label, transition, max(0.0, current_duration - transition), output)
        )
        current = output
        current_duration += scene_durations[index] - transition
    if caption:
        graph.append(
            "[%s]ass='%s'[captioned]"
            % (current, _filter_escape(Path(str(caption["ass"]))))
        )
        current = "captioned"
    watermark_text = str(options.get("watermarkText") or "").strip()
    if watermark_text:
        position = _watermark_text_position(
            str(options.get("watermarkTextPosition", "w-tw-32:h-th-32"))
        )
        opacity = max(0.1, min(1.0, float(options.get("watermarkTextOpacity", 0.75))))
        graph.append(
            "[%s]drawtext=text='%s':x=%s:y=%s:fontsize=%d:fontcolor=white@%.2f:box=1:boxcolor=black@0.45:boxborderw=16[branded]"
            % (
                current,
                _drawtext_escape(watermark_text),
                position[0],
                position[1],
                int(options.get("watermarkTextSize", 42)),
                opacity,
            )
        )
        current = "branded"
    return ";".join(graph), current


def _crop_keyframes(
    values: Sequence[Any],
    scene_start: float,
    source_width: int,
    source_height: int,
    crop_width: int,
    crop_height: int,
) -> tuple[List[tuple[float, float]], List[tuple[float, float]]]:
    xs: List[tuple[float, float]] = []
    ys: List[tuple[float, float]] = []
    for value in values:
        if not isinstance(value, Mapping):
            continue
        time = max(0.0, float(value.get("time", scene_start)) - scene_start)
        x = max(0.0, min(source_width - crop_width, float(value.get("x", source_width / 2)) - crop_width / 2))
        y = max(0.0, min(source_height - crop_height, float(value.get("y", source_height / 2)) - crop_height * 0.38))
        xs.append((time, float(int(x) // 2 * 2)))
        ys.append((time, float(int(y) // 2 * 2)))
    if not xs:
        xs = [(0.0, float(max(0, (source_width - crop_width) // 2 // 2 * 2)))]
        ys = [(0.0, float(max(0, (source_height - crop_height) // 2 // 2 * 2)))]
    elif xs[0][0] > 0:
        xs.insert(0, (0.0, xs[0][1]))
        ys.insert(0, (0.0, ys[0][1]))
    return xs, ys


def _piecewise_expression(values: Sequence[tuple[float, float]]) -> str:
    if len(values) == 1:
        return "%.2f" % values[0][1]
    expression = "%.2f" % values[-1][1]
    for (start_time, start_value), (end_time, end_value) in reversed(list(zip(values, values[1:]))):
        duration = max(0.001, end_time - start_time)
        interpolation = "%.2f+(%.2f)*(t-%.3f)/%.3f" % (
            start_value,
            end_value - start_value,
            start_time,
            duration,
        )
        expression = "if(lt(t\\,%.3f)\\,%s\\,%s)" % (end_time, interpolation, expression)
    return expression


def _subject_crop(
    subject: Any,
    source_width: int,
    source_height: int,
    crop_width: int,
    crop_height: int,
) -> tuple[int, int]:
    value = subject if isinstance(subject, Mapping) else {}
    center_x = float(value.get("x", 0.5)) * source_width
    center_y = float(value.get("y", 0.45)) * source_height
    x = max(0, min(source_width - crop_width, int(center_x - crop_width / 2)))
    y = max(0, min(source_height - crop_height, int(center_y - crop_height * 0.38)))
    return x // 2 * 2, y // 2 * 2


def _filter_escape(path: Path) -> str:
    return (
        str(path.resolve())
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "'\\''")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


def _smart_crop_filter(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, Mapping):
        raise WorkerError("INVALID_SMART_CROP", "Smart crop geometry is invalid")
    names = ("width", "height", "x", "y", "targetWidth", "targetHeight")
    try:
        geometry = {name: int(value[name]) for name in names}
    except (KeyError, TypeError, ValueError) as error:
        raise WorkerError("INVALID_SMART_CROP", "Smart crop geometry is incomplete") from error
    if (
        geometry["width"] < 2
        or geometry["height"] < 2
        or geometry["targetWidth"] < 2
        or geometry["targetHeight"] < 2
        or geometry["x"] < 0
        or geometry["y"] < 0
        or any(number > 10_000 for number in geometry.values())
    ):
        raise WorkerError("INVALID_SMART_CROP", "Smart crop geometry is outside supported bounds")
    return "crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos" % (
        geometry["width"],
        geometry["height"],
        geometry["x"],
        geometry["y"],
        geometry["targetWidth"],
        geometry["targetHeight"],
    )


def _drawtext_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace("%", "\\%")
        .replace("\n", " ")
        .replace("\r", " ")
    )


def _watermark_text_position(value: str) -> tuple[str, str]:
    normalized = value.replace("W", "w").replace("H", "h")
    allowed = {
        "32:32": ("32", "32"),
        "w-tw-32:32": ("w-tw-32", "32"),
        "32:h-th-32": ("32", "h-th-32"),
        "w-tw-32:h-th-32": ("w-tw-32", "h-th-32"),
    }
    if normalized not in allowed:
        raise WorkerError("INVALID_WATERMARK_POSITION", "Unsupported watermark position")
    return allowed[normalized]
