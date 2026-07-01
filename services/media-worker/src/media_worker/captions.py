from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence


TEMPLATES: Dict[str, Dict[str, Any]] = {
    "podcast": {
        "font": "Montserrat ExtraBold",
        "size": 58,
        "primary": "&H00FFFFFF",
        "highlight": "&H0000D7FF",
    },
    "business": {
        "font": "Arial",
        "size": 52,
        "primary": "&H00FFFFFF",
        "highlight": "&H00F0C040",
    },
    "finance": {
        "font": "Montserrat SemiBold",
        "size": 54,
        "primary": "&H00FFFFFF",
        "highlight": "&H0048E070",
    },
    "marketing": {
        "font": "Poppins ExtraBold",
        "size": 58,
        "primary": "&H00FFFFFF",
        "highlight": "&H00FF55CC",
    },
    "motivational": {
        "font": "Anton",
        "size": 62,
        "primary": "&H00FFFFFF",
        "highlight": "&H0000BFFF",
    },
}


def build_caption_files(
    transcript: Mapping[str, Any],
    clips: Sequence[Mapping[str, Any]],
    output_dir: Path,
    *,
    template_name: str = "podcast",
    words_per_cue: int = 4,
) -> List[Dict[str, Any]]:
    template_key = template_name.lower()
    if template_key not in TEMPLATES:
        raise ValueError("Unknown caption template: %s" % template_name)
    output_dir.mkdir(parents=True, exist_ok=True)
    all_words = _transcript_words(transcript)
    outputs = []
    for clip in clips:
        clip_start, clip_end = float(clip["start"]), float(clip["end"])
        words = [
            word
            for word in all_words
            if word["end"] > clip_start and word["start"] < clip_end
        ]
        cues = group_words(
            words, clip_start=clip_start, clip_end=clip_end, words_per_cue=words_per_cue
        )
        if not cues:
            continue
        stem = str(clip["id"])
        srt_path = output_dir / (stem + ".srt")
        ass_path = output_dir / (stem + ".ass")
        srt_path.write_text(render_srt(cues), encoding="utf-8")
        ass_path.write_text(
            render_ass(cues, TEMPLATES[template_key], template_key), encoding="utf-8"
        )
        outputs.append(
            {
                "clipId": clip["id"],
                "srt": str(srt_path),
                "ass": str(ass_path),
                "cueCount": len(cues),
                "cues": cues,
            }
        )
    return outputs


def group_words(
    words: Sequence[Mapping[str, Any]],
    *,
    clip_start: float,
    clip_end: float,
    words_per_cue: int = 4,
) -> List[Dict[str, Any]]:
    words_per_cue = max(1, min(8, words_per_cue))
    cues = []
    for index in range(0, len(words), words_per_cue):
        group = words[index : index + words_per_cue]
        start = max(0.0, float(group[0]["start"]) - clip_start)
        end = min(clip_end - clip_start, float(group[-1]["end"]) - clip_start)
        normalized = [
            {
                "word": str(value["word"]).strip(),
                "start": max(start, float(value["start"]) - clip_start),
                "end": min(end, float(value["end"]) - clip_start),
            }
            for value in group
            if str(value.get("word", "")).strip()
        ]
        if normalized and end > start:
            cues.append({"start": start, "end": end, "words": normalized})
    return cues


def render_srt(cues: Sequence[Mapping[str, Any]]) -> str:
    blocks = []
    for index, cue in enumerate(cues, 1):
        text = " ".join(word["word"] for word in cue["words"])
        blocks.append(
            "%d\n%s --> %s\n%s"
            % (index, srt_timestamp(cue["start"]), srt_timestamp(cue["end"]), text)
        )
    return "\n\n".join(blocks) + "\n"


def render_ass(
    cues: Sequence[Mapping[str, Any]], style: Mapping[str, Any], template_name: str
) -> str:
    header = """[Script Info]
Title: SuperCortesLikes captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},{highlight},&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,2,70,70,260,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""".format(**style)
    lines = []
    for cue in cues:
        karaoke = []
        for word in cue["words"]:
            duration_cs = max(
                1, round((float(word["end"]) - float(word["start"])) * 100)
            )
            escaped = ass_escape(str(word["word"]).upper())
            karaoke.append("{\\k%d}%s" % (duration_cs, escaped))
        lines.append(
            "Dialogue: 0,%s,%s,Default,,0,0,0,karaoke,%s"
            % (
                ass_timestamp(cue["start"]),
                ass_timestamp(cue["end"]),
                " ".join(karaoke),
            )
        )
    return header + "\n".join(lines) + "\n"


def srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return "%02d:%02d:%02d,%03d" % (hours, minutes, secs, millis)


def ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360_000)
    minutes, remainder = divmod(remainder, 6000)
    secs, cents = divmod(remainder, 100)
    return "%d:%02d:%02d.%02d" % (hours, minutes, secs, cents)


def ass_escape(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\n", "\\N")
    )


def _transcript_words(transcript: Mapping[str, Any]) -> List[Dict[str, Any]]:
    words = []
    for segment in transcript.get("segments", []):
        if segment.get("words"):
            words.extend(segment["words"])
            continue
        text_words = str(segment.get("text", "")).split()
        if not text_words:
            continue
        start, end = float(segment["start"]), float(segment["end"])
        step = (end - start) / len(text_words)
        words.extend(
            {
                "word": word,
                "start": start + index * step,
                "end": start + (index + 1) * step,
            }
            for index, word in enumerate(text_words)
        )
    return sorted(words, key=lambda value: float(value["start"]))
