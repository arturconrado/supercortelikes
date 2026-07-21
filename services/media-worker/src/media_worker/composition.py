from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

from .config import Settings
from .vision import analyze_focus


COMPOSITION_VERSION = "composition-v1"
SUPPORTED_ASPECTS = {"9:16", "1:1", "4:5", "16:9"}


def build_compositions(
    source: Any,
    clips: Sequence[Mapping[str, Any]],
    settings: Settings,
    options: Mapping[str, Any],
) -> List[Dict[str, Any]]:
    aspect = str(options.get("aspectRatio", "9:16"))
    if aspect not in SUPPORTED_ASPECTS:
        aspect = "9:16"
    enabled = bool(options.get("enabled", True))
    minimum_sample = 0.1 if settings.media_accelerator == "cuda" else 0.25
    sample_seconds = max(
        minimum_sample,
        min(1.0, float(options.get("sampleSeconds", minimum_sample))),
    )
    minimum_confidence = max(
        0.0, min(1.0, float(options.get("minimumSpeakerConfidence", 0.65)))
    )
    detector = str(options.get("detector", "opencv"))
    budget_ratio = max(0.25, min(4.0, float(options.get("analysisBudgetRatio", 1.0))))
    plans: List[Dict[str, Any]] = []
    for clip in clips:
        start, end = float(clip["start"]), float(clip["end"])
        if not enabled:
            plans.append(fallback_plan(clip, aspect, "disabled"))
            continue
        try:
            analysis = analyze_focus(
                source,
                detector,
                settings,
                sample_seconds=sample_seconds,
                start_seconds=start,
                end_seconds=end,
                time_budget_seconds=max(2.0, (end - start) * budget_ratio),
            )
            _combine_voice_activity(analysis, options.get("voiceActivity"))
            plans.append(
                composition_plan(
                    clip,
                    analysis,
                    aspect=aspect,
                    minimum_confidence=minimum_confidence,
                )
            )
        except Exception as error:
            plan = fallback_plan(clip, aspect, "analysis-failed")
            plan["diagnostics"]["error"] = type(error).__name__
            plans.append(plan)
    for plan in plans:
        if int(plan.get("source", {}).get("width", 0)) <= 0:
            plan["source"] = {
                "width": max(0, int(options.get("sourceWidth", 0))),
                "height": max(0, int(options.get("sourceHeight", 0))),
            }
        plan["accelerator"] = settings.media_accelerator
        plan.setdefault("diagnostics", {})["accelerator"] = settings.media_accelerator
    return plans


def _combine_voice_activity(analysis: Dict[str, Any], intervals: Any) -> None:
    if not isinstance(intervals, list):
        return
    normalized = []
    for interval in intervals:
        if not isinstance(interval, Mapping):
            continue
        try:
            normalized.append(
                (
                    float(interval["start"]),
                    float(interval["end"]),
                    str(interval.get("speaker") or ""),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    for sample in analysis.get("samples", []):
        time = float(sample.get("time", 0.0))
        active_intervals = [
            (start, end, speaker)
            for start, end, speaker in normalized
            if start - 0.1 <= time <= end + 0.1
        ]
        voice_active = bool(active_intervals)
        sample["voiceActive"] = voice_active
        sample["speaker"] = next(
            (speaker for _start, _end, speaker in active_intervals if speaker), None
        )
        if not voice_active:
            sample["activeSpeakerConfidence"] = float(sample.get("activeSpeakerConfidence", 0.0)) * 0.2
            for box in sample.get("boxes", []):
                box["activity"] = float(box.get("activity", 0.0)) * 0.2
    speaker_track_map = _associate_speakers_with_tracks(analysis.get("samples", []))
    if speaker_track_map:
        analysis["speakerTrackMap"] = speaker_track_map
        analysis["activeSpeakerMethod"] = (
            "diarization-plus-visual-track-plus-face-region-motion"
        )
    else:
        analysis["activeSpeakerMethod"] = "voice-activity-plus-face-region-motion"


def _associate_speakers_with_tracks(samples: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    next_track_id = 1
    previous: List[Dict[str, Any]] = []
    scores: Dict[str, Dict[int, float]] = {}
    for sample in samples:
        current = [box for box in sample.get("boxes", []) if isinstance(box, dict)]
        available = list(previous)
        for box in current:
            best = max(available, key=lambda value: _box_iou(box, value), default=None)
            if best is not None and _box_iou(box, best) >= 0.2:
                track_id = int(best["trackId"])
                available.remove(best)
            else:
                track_id = next_track_id
                next_track_id += 1
            box["trackId"] = track_id
        previous = [dict(box) for box in current]
        speaker = sample.get("speaker")
        if not speaker:
            continue
        speaker_scores = scores.setdefault(str(speaker), {})
        for box in current:
            track_id = int(box["trackId"])
            speaker_scores[track_id] = speaker_scores.get(track_id, 0.0) + float(
                box.get("activity", 0.0)
            )

    mapping = {
        speaker: max(track_scores, key=track_scores.get)
        for speaker, track_scores in scores.items()
        if track_scores
    }
    for sample in samples:
        expected = mapping.get(str(sample.get("speaker") or ""))
        if expected is None:
            continue
        matched_activity = 0.0
        for box in sample.get("boxes", []):
            activity = float(box.get("activity", 0.0))
            if int(box.get("trackId", -1)) == expected:
                activity = max(0.85, activity)
                matched_activity = max(matched_activity, activity)
            else:
                activity *= 0.25
            box["activity"] = round(activity, 4)
        sample["activeSpeakerConfidence"] = round(matched_activity, 4)
    return mapping


def _box_iou(left: Mapping[str, Any], right: Mapping[str, Any]) -> float:
    left_x, left_y = float(left.get("x", 0)), float(left.get("y", 0))
    right_x, right_y = float(right.get("x", 0)), float(right.get("y", 0))
    left_right = left_x + float(left.get("width", 0))
    left_bottom = left_y + float(left.get("height", 0))
    right_right = right_x + float(right.get("width", 0))
    right_bottom = right_y + float(right.get("height", 0))
    intersection = max(0.0, min(left_right, right_right) - max(left_x, right_x)) * max(
        0.0, min(left_bottom, right_bottom) - max(left_y, right_y)
    )
    union = (
        max(0.0, left_right - left_x) * max(0.0, left_bottom - left_y)
        + max(0.0, right_right - right_x) * max(0.0, right_bottom - right_y)
        - intersection
    )
    return intersection / union if union > 0 else 0.0


def fallback_plan(
    clip: Mapping[str, Any], aspect: str, reason: str = "low-confidence"
) -> Dict[str, Any]:
    start, end = float(clip["start"]), float(clip["end"])
    return {
        "clipId": clip["id"],
        "version": COMPOSITION_VERSION,
        "aspectRatio": aspect,
        "source": {"width": 0, "height": 0},
        "scenes": [
            {
                "start": start,
                "end": end,
                "layout": "fit",
                "confidence": 0.0,
                "captionSafeZone": "bottom",
                "keyframes": [],
                "subjects": [],
            }
        ],
        "diagnostics": {
            "status": "fallback",
            "reason": reason,
            "detectionRate": 0.0,
            "layoutSwitches": 0,
            "sampleCount": 0,
        },
    }


def composition_plan(
    clip: Mapping[str, Any],
    analysis: Mapping[str, Any],
    *,
    aspect: str,
    minimum_confidence: float = 0.65,
) -> Dict[str, Any]:
    width, height = int(analysis["width"]), int(analysis["height"])
    samples = list(analysis.get("samples") or [])
    if not samples:
        return fallback_plan(clip, aspect)
    detection_rate = float(analysis.get("detectionRate", 0.0))
    if detection_rate < 0.35:
        plan = fallback_plan(clip, aspect, "detection-rate")
        plan["source"] = {"width": width, "height": height}
        plan["diagnostics"]["detectionRate"] = round(detection_rate, 4)
        plan["diagnostics"]["sampleCount"] = len(samples)
        return plan

    labeled = []
    for sample in samples:
        boxes = sorted(
            list(sample.get("boxes") or []),
            key=lambda box: (
                float(box.get("activity", 0.0)),
                float(box.get("confidence", 0.0))
                * float(box.get("width", 0.0))
                * float(box.get("height", 0.0)),
            ),
            reverse=True,
        )
        activity = float(sample.get("activeSpeakerConfidence", 0.0))
        if not boxes:
            layout = "fit"
        elif len(boxes) >= 2 and activity < minimum_confidence:
            layout = "split"
        else:
            layout = "fill"
        primary = boxes[0] if boxes else None
        focus_x = (
            float(primary["x"]) + float(primary["width"]) / 2
            if primary
            else float(sample.get("x", width / 2))
        )
        focus_y = (
            float(primary["y"]) + float(primary["height"]) * 0.45
            if primary
            else float(sample.get("y", height / 2))
        )
        labeled.append(
            {
                "time": float(sample["time"]),
                "layout": layout,
                "confidence": max(activity, 0.72 if len(boxes) == 1 else 0.45),
                "focusX": focus_x,
                "focusY": focus_y,
                "boxes": boxes[:2],
            }
        )

    labeled = stabilize_layouts(labeled, minimum_seconds=0.6)
    keyframes = smooth_keyframes(labeled, width, height)
    scenes = _scenes(labeled, keyframes, float(clip["start"]), float(clip["end"]), width, height)
    mean_confidence = sum(float(value["confidence"]) for value in labeled) / len(labeled)
    return {
        "clipId": clip["id"],
        "version": COMPOSITION_VERSION,
        "aspectRatio": aspect,
        "source": {"width": width, "height": height},
        "scenes": scenes,
        "diagnostics": {
            "status": "ready",
            "detectionRate": round(detection_rate, 4),
            "trackingConfidence": round(mean_confidence, 4),
            "layoutSwitches": max(0, len(scenes) - 1),
            "sampleCount": len(labeled),
            "sampleSeconds": round(
                max(0.0, labeled[1]["time"] - labeled[0]["time"])
                if len(labeled) > 1
                else 0.0,
                3,
            ),
        },
    }


def stabilize_layouts(
    samples: Sequence[Mapping[str, Any]], *, minimum_seconds: float
) -> List[Dict[str, Any]]:
    values = [dict(sample) for sample in samples]
    if len(values) < 2:
        return values
    index = 0
    while index < len(values):
        end = index + 1
        while end < len(values) and values[end]["layout"] == values[index]["layout"]:
            end += 1
        duration = float(values[end - 1]["time"]) - float(values[index]["time"])
        if duration < minimum_seconds:
            replacement = (
                values[index - 1]["layout"]
                if index > 0
                else values[end]["layout"] if end < len(values) else values[index]["layout"]
            )
            for item in range(index, end):
                values[item]["layout"] = replacement
        index = end
    return values


def smooth_keyframes(
    samples: Sequence[Mapping[str, Any]], width: int, height: int
) -> List[Dict[str, float]]:
    values: List[Dict[str, float]] = []
    current_x, current_y = width / 2, height / 2
    max_x_step, max_y_step = width * 0.08, height * 0.08
    for sample in samples:
        target_x, target_y = float(sample["focusX"]), float(sample["focusY"])
        delta_x, delta_y = target_x - current_x, target_y - current_y
        if abs(delta_x) < width * 0.03:
            delta_x = 0.0
        if abs(delta_y) < height * 0.03:
            delta_y = 0.0
        current_x += max(-max_x_step, min(max_x_step, delta_x * 0.35))
        current_y += max(-max_y_step, min(max_y_step, delta_y * 0.35))
        values.append(
            {
                "time": round(float(sample["time"]), 3),
                "x": round(max(0.0, min(float(width), current_x)), 2),
                "y": round(max(0.0, min(float(height), current_y)), 2),
                "confidence": round(float(sample["confidence"]), 4),
            }
        )
    return values


def _scenes(
    samples: Sequence[Mapping[str, Any]],
    keyframes: Sequence[Mapping[str, Any]],
    clip_start: float,
    clip_end: float,
    width: int,
    height: int,
) -> List[Dict[str, Any]]:
    scenes: List[Dict[str, Any]] = []
    index = 0
    while index < len(samples):
        end = index + 1
        while end < len(samples) and samples[end]["layout"] == samples[index]["layout"]:
            end += 1
        scene_start = clip_start if index == 0 else float(samples[index]["time"])
        scene_end = clip_end if end == len(samples) else float(samples[end]["time"])
        scene_samples = samples[index:end]
        boxes = next((value["boxes"] for value in scene_samples if value.get("boxes")), [])
        subjects = [
            {
                "x": round((float(box["x"]) + float(box["width"]) / 2) / width, 5),
                "y": round((float(box["y"]) + float(box["height"]) * 0.45) / height, 5),
                "width": round(float(box["width"]) / width, 5),
                "height": round(float(box["height"]) / height, 5),
            }
            for box in boxes[:2]
        ]
        scenes.append(
            {
                "start": round(max(clip_start, scene_start), 3),
                "end": round(min(clip_end, max(scene_start + 0.04, scene_end)), 3),
                "layout": str(samples[index]["layout"]),
                "confidence": round(
                    sum(float(value["confidence"]) for value in scene_samples)
                    / len(scene_samples),
                    4,
                ),
                "captionSafeZone": "bottom",
                "keyframes": [dict(value) for value in keyframes[index:end]],
                "subjects": subjects,
            }
        )
        index = end
    return scenes
