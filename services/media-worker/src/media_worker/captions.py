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
        "font": "Liberation Sans",
        "size": 52,
        "primary": "&H00FFFFFF",
        "highlight": "&H00F0C040",
    },
    "finance": {
        "font": "Nimbus Mono PS",
        "size": 54,
        "primary": "&H00FFFFFF",
        "highlight": "&H0048E070",
    },
    "marketing": {
        "font": "Nimbus Sans Narrow",
        "size": 58,
        "primary": "&H00FFFFFF",
        "highlight": "&H00FF55CC",
    },
    "motivational": {
        "font": "URW Bookman",
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
    groups: List[List[Mapping[str, Any]]] = []
    pending: List[Mapping[str, Any]] = []
    for index, word in enumerate(words):
        pending.append(word)
        next_word = words[index + 1] if index + 1 < len(words) else None
        pause = (
            float(next_word["start"]) - float(word["end"])
            if next_word is not None
            else 0.0
        )
        duration = float(word["end"]) - float(pending[0]["start"])
        punctuation_break = str(word.get("word", "")).rstrip().endswith((".", "!", "?", ":", ";"))
        if (
            len(pending) >= words_per_cue
            or pause >= 0.32
            or duration >= 2.2
            or (punctuation_break and len(pending) >= 2)
            or next_word is None
        ):
            groups.append(pending)
            pending = []
    cues = []
    for group in groups:
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
            cues.append(
                {
                    "start": start,
                    "end": end,
                    "words": normalized,
                    "keywordIndex": _keyword_index(normalized),
                }
            )
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
    resolved_style = {
        "back": "&H80000000",
        "border_style": 1,
        "outline": 5,
        "shadow": 2,
        "alignment": 2,
        "margin_v": 260,
        "keyword": "&H0000D7FF",
        "case": "upper",
        "animation": "pop",
        **style,
    }
    header = """[Script Info]
Title: SuperCortesLikes captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},{highlight},&H00101010,{back},-1,0,0,0,100,100,0,0,{border_style},{outline},{shadow},{alignment},70,70,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
""".format(**resolved_style)
    lines = []
    for cue in cues:
        karaoke = []
        keyword_index = int(cue.get("keywordIndex", -1))
        for index, word in enumerate(cue["words"]):
            duration_cs = max(
                1, round((float(word["end"]) - float(word["start"])) * 100)
            )
            escaped = ass_escape(_caption_case(str(word["word"]), str(resolved_style["case"])))
            prefix = "\\k%d\\c%s" % (
                duration_cs,
                resolved_style["keyword"]
                if index == keyword_index
                else resolved_style["primary"],
            )
            if resolved_style["animation"] == "pop":
                prefix += "\\fscx108\\fscy108\\t(0,140,\\fscx100\\fscy100)"
            karaoke.append("{%s}%s" % (prefix, escaped))
        lines.append(
            "Dialogue: 0,%s,%s,Default,,0,0,0,karaoke,%s"
            % (
                ass_timestamp(cue["start"]),
                ass_timestamp(cue["end"]),
                " ".join(karaoke),
            )
        )
    return header + "\n".join(lines) + "\n"


def caption_style(template_name: str, overrides: Mapping[str, Any]) -> Dict[str, Any]:
    template = dict(TEMPLATES.get(template_name.lower(), TEMPLATES["podcast"]))
    template["primary"] = _ass_color(overrides.get("primaryColor"), template["primary"])
    template["highlight"] = _ass_color(
        overrides.get("activeColor", overrides.get("highlightColor")), template["highlight"]
    )
    template["keyword"] = _ass_color(overrides.get("keywordColor"), template["highlight"])
    template["case"] = str(overrides.get("case", "upper")).lower()
    if template["case"] not in {"upper", "lower", "title", "preserve"}:
        template["case"] = "upper"
    template["animation"] = str(overrides.get("animation", "pop")).lower()
    if template["animation"] not in {"none", "pop"}:
        template["animation"] = "pop"
    try:
        template["size"] = max(18, min(96, int(overrides.get("fontSize", template["size"]))))
    except (TypeError, ValueError):
        pass
    position = str(overrides.get("position", "auto"))
    if position == "top":
        template.update({"alignment": 8, "margin_v": 140})
    elif position == "middle":
        template.update({"alignment": 5, "margin_v": 0})
    else:
        template.update({"alignment": 2, "margin_v": 260})
    if bool(overrides.get("background", False)):
        template.update({"back": "&H60000000", "border_style": 3, "outline": 0, "shadow": 0})
    return template


def normalize_cues(values: Any, duration: float, offset_seconds: float = 0.0) -> List[Dict[str, Any]]:
    if not isinstance(values, list):
        return []
    cues = []
    for value in values:
        if not isinstance(value, Mapping):
            continue
        try:
            start = max(0.0, float(value["start"]) + offset_seconds)
            end = min(duration, float(value["end"]) + offset_seconds)
        except (KeyError, TypeError, ValueError):
            continue
        if end <= start:
            continue
        words = []
        raw_words = value.get("words")
        if isinstance(raw_words, list):
            for item in raw_words:
                if not isinstance(item, Mapping) or not str(item.get("word", "")).strip():
                    continue
                try:
                    word_start = max(start, float(item["start"]) + offset_seconds) if "start" in item else start
                    word_end = min(end, float(item["end"]) + offset_seconds) if "end" in item else end
                except (TypeError, ValueError):
                    continue
                if word_end > word_start:
                    words.append({"word": str(item["word"]).strip(), "start": word_start, "end": word_end})
        if not words and str(value.get("text", "")).strip():
            text_words = str(value["text"]).split()
            step = (end - start) / len(text_words)
            words = [
                {"word": word, "start": start + index * step, "end": start + (index + 1) * step}
                for index, word in enumerate(text_words)
            ]
        if words:
            cues.append({"start": start, "end": end, "words": words})
    return cues


def _ass_color(value: Any, fallback: str) -> str:
    text = str(value or "")
    if len(text) != 7 or not text.startswith("#"):
        return fallback
    try:
        red, green, blue = int(text[1:3], 16), int(text[3:5], 16), int(text[5:7], 16)
    except ValueError:
        return fallback
    return "&H00%02X%02X%02X" % (blue, green, red)


def _caption_case(value: str, mode: str) -> str:
    if mode == "lower":
        return value.lower()
    if mode == "title":
        return value.title()
    if mode == "preserve":
        return value
    return value.upper()


def _keyword_index(words: Sequence[Mapping[str, Any]]) -> int:
    stopwords = {
        "a", "as", "o", "os", "e", "de", "da", "do", "das", "dos", "em", "um", "uma",
        "que", "para", "por", "com", "na", "no", "nas", "nos", "the", "and", "for",
    }
    candidates = []
    for index, word in enumerate(words):
        normalized = "".join(character for character in str(word.get("word", "")).lower() if character.isalnum())
        if normalized and normalized not in stopwords:
            candidates.append((len(normalized), index))
    return max(candidates, default=(0, -1))[1]


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
