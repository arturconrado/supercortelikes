from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .openrouter_video import (
    OpenRouterVideoError,
    analyze_video,
    create_proxy,
    enabled as video_enabled,
)

logger = logging.getLogger(__name__)


def enabled(settings: Any) -> bool:
    return video_enabled(settings) and bool(
        getattr(settings, "openrouter_active_speaker_enabled", True)
    )


def analyze_clip_speakers(
    source: Path,
    clip: Mapping[str, Any],
    settings: Any,
    output_dir: Path,
    *,
    cost_remaining_usd: Optional[float] = None,
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Dict[str, Any]]]:
    """Ask the OpenRouter video model who is speaking and when there is
    cross-talk in this clip's time range, using the raw source (not a
    rendered/composed clip). Returns `(intervals, usage)`. Returns
    `(None, None)` on any failure or unavailability -- callers must degrade
    to the visual-only signal in that case; this never raises.
    """
    clip_id = str(clip.get("id") or "")
    if not enabled(settings):
        return None, None
    if cost_remaining_usd is not None and cost_remaining_usd <= 0:
        return None, None
    try:
        proxy = create_proxy(
            source,
            output_dir,
            settings,
            clip_id=clip_id,
            start_seconds=float(clip["start"]),
            end_seconds=float(clip["end"]),
        )
        if proxy is None:
            return None, None
        result = analyze_video(
            proxy,
            _speaker_prompt(clip),
            settings,
            max_tokens=900,
        )
        return _parse_intervals(result["content"], clip), result["usage"]
    except (OSError, ValueError, KeyError, OpenRouterVideoError) as error:
        logger.warning(
            "AI speaker analysis failed for %s; falling back to the visual signal: %s",
            clip_id,
            error,
        )
        return None, None


def _speaker_prompt(clip: Mapping[str, Any]) -> Dict[str, Any]:
    duration_ms = max(0, round((float(clip["end"]) - float(clip["start"])) * 1000))
    return {
        "task": (
            "Watch this short video segment with audio and identify, over time, "
            "who is actively speaking. Report each active speaker's approximate "
            "on-screen position as a fraction of frame width/height (0,0 is "
            "top-left, 1,1 is bottom-right), and flag windows where two or more "
            "people are speaking or audibly reacting at the same time."
        ),
        "clip": {"durationMs": duration_ms},
        "response": {
            "activity": [
                {
                    "startMs": 0,
                    "endMs": 1000,
                    "speakers": [{"xRatio": 0.5, "yRatio": 0.4}],
                    "crossTalk": False,
                }
            ]
        },
        "rules": (
            "Return JSON only. Cover the whole segment with contiguous, "
            "non-overlapping windows in `activity`. `speakers` lists the "
            "on-screen position of everyone actively speaking or audibly "
            "reacting in that window (a single entry when only one person is "
            "talking, empty when no one on screen is speaking). Set crossTalk "
            "to true only when two or more people are speaking or reacting at "
            "once. Do not invent a position for someone who is silent."
        ),
    }


def _parse_intervals(
    content: str, clip: Mapping[str, Any]
) -> Optional[List[Dict[str, Any]]]:
    try:
        payload = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(payload, Mapping):
        return None
    raw = payload.get("activity")
    if not isinstance(raw, list):
        return None
    clip_start, clip_end = float(clip["start"]), float(clip["end"])
    duration = max(0.0, clip_end - clip_start)
    intervals: List[Dict[str, Any]] = []
    for value in raw:
        if not isinstance(value, Mapping):
            continue
        try:
            start = clip_start + max(
                0.0, min(duration, float(value.get("startMs", 0)) / 1000)
            )
            end = clip_start + max(
                0.0, min(duration, float(value.get("endMs", 0)) / 1000)
            )
        except (TypeError, ValueError):
            continue
        if end <= start:
            continue
        speakers = []
        for speaker in value.get("speakers") or []:
            if not isinstance(speaker, Mapping):
                continue
            try:
                x_ratio = max(0.0, min(1.0, float(speaker.get("xRatio", 0.5))))
                y_ratio = max(0.0, min(1.0, float(speaker.get("yRatio", 0.5))))
            except (TypeError, ValueError):
                continue
            speakers.append({"xRatio": x_ratio, "yRatio": y_ratio})
        if not speakers:
            continue
        intervals.append(
            {
                "start": start,
                "end": end,
                "speakers": speakers,
                "crossTalk": bool(value.get("crossTalk")) and len(speakers) >= 2,
            }
        )
    return intervals or None
