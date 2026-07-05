from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence

from .config import Settings
from .errors import ArtifactMissing, WorkerError
from .process import run_command


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
        if caption:
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
        if watermark:
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
                "-c:v",
                "libx264",
                "-preset",
                str(options.get("preset", settings.ffmpeg_preset)),
                "-crf",
                str(int(options.get("crf", settings.ffmpeg_crf))),
                "-c:a",
                "aac",
                "-b:a",
                "192k",
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


def _filter_escape(path: Path) -> str:
    return (
        str(path.resolve())
        .replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "'\\''")
        .replace("[", "\\[")
        .replace("]", "\\]")
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
