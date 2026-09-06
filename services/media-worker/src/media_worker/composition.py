from __future__ import annotations

from typing import Any, Dict, List, Mapping, Sequence

from .config import Settings
from . import speaker_ai
from .vision import analyze_focus, crop_dimensions


COMPOSITION_VERSION = "composition-v2"
ASPECT_RATIOS = {"9:16": (9, 16), "1:1": (1, 1), "4:5": (4, 5), "16:9": (16, 9)}
SUPPORTED_ASPECTS = set(ASPECT_RATIOS)
FRAMING_PROFILE = {
    "name": "social-center-v1",
    "targetX": 0.5,
    "targetFaceY": 0.38,
    "safeCenterX": [0.2, 0.8],
    "safeCenterY": [0.12, 0.62],
    "safeFaceBounds": [0.04, 0.04, 0.96, 0.78],
    "minimumPersonHeightRatio": 0.18,
    "minimumPersonAreaRatio": 0.01,
}


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
    detector = str(options.get("detector", "auto"))
    default_budget_ratio = 1.0 if settings.media_accelerator == "cuda" else 4.0
    budget_ratio = max(
        0.25,
        min(
            4.0,
            float(options.get("analysisBudgetRatio", default_budget_ratio)),
        ),
    )
    plans: List[Dict[str, Any]] = []
    # Decided once per composition run, not per clip: whenever the AI speaker
    # signal is authoritative, the extra lip-region detector pass in
    # `analyze_focus` is redundant CPU work -- `_motion_activity` still runs on
    # the plain boxes as a non-degenerate fallback for any clip/window the AI
    # call ends up not covering (see `speaker_ai`/item 9).
    skip_lip_region_refinement = speaker_ai.enabled(settings)
    ai_speaker_activity = options.get("aiSpeakerActivity") or {}
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
                skip_lip_region_refinement=skip_lip_region_refinement,
            )
            _combine_voice_activity(analysis, options.get("voiceActivity"))
            _combine_ai_speaker_activity(
                analysis, ai_speaker_activity.get(str(clip["id"]))
            )
            plans.append(
                composition_plan(
                    clip,
                    analysis,
                    aspect=aspect,
                    minimum_confidence=minimum_confidence,
                    focus_switch_delay_seconds=max(
                        0.0,
                        min(
                            0.4,
                            float(options.get("focusSwitchDelaySeconds", 0.25)),
                        ),
                    ),
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
                    0.04 if interval.get("kind") == "word" else 0.1,
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    for sample in analysis.get("samples", []):
        time = float(sample.get("time", 0.0))
        active_intervals = [
            (start, end, speaker)
            for start, end, speaker, padding in normalized
            if start - padding <= time <= end + padding
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
        if not current:
            continue
        available = list(previous)
        for box in current:
            if box.get("trackId") is not None:
                track_id = int(box["trackId"])
                available = [
                    value for value in available if int(value.get("trackId", -1)) != track_id
                ]
                next_track_id = max(next_track_id, track_id + 1)
                box["trackId"] = track_id
                continue
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


def _combine_ai_speaker_activity(analysis: Dict[str, Any], intervals: Any) -> None:
    """Fold the proactive AI speaker signal (`speaker_ai`) into `analysis`
    samples, mirroring how `_combine_voice_activity`/`_associate_speakers_with_tracks`
    fold in diarization -- except positions are matched to the nearest visual
    box instead of an already-known speaker/track id. No-op when there is no
    AI coverage for this clip (disabled, unavailable, or budget exhausted)."""
    if not isinstance(intervals, list) or not intervals:
        return
    normalized = []
    for interval in intervals:
        if not isinstance(interval, Mapping):
            continue
        speakers = [
            speaker
            for speaker in interval.get("speakers") or []
            if isinstance(speaker, Mapping)
            and isinstance(speaker.get("xRatio"), (int, float))
            and isinstance(speaker.get("yRatio"), (int, float))
        ]
        if not speakers:
            continue
        try:
            normalized.append(
                (
                    float(interval["start"]),
                    float(interval["end"]),
                    speakers,
                    bool(interval.get("crossTalk")),
                )
            )
        except (KeyError, TypeError, ValueError):
            continue
    if not normalized:
        return
    width = float(analysis.get("width") or 0.0)
    height = float(analysis.get("height") or 0.0)
    covered_any = False
    for sample in analysis.get("samples", []):
        time = float(sample.get("time", 0.0))
        match = next(
            (
                (speakers, cross_talk)
                for start, end, speakers, cross_talk in normalized
                if start - 0.1 <= time <= end + 0.1
            ),
            None,
        )
        if match is None:
            continue
        speakers, cross_talk = match
        sample["aiCovered"] = True
        covered_any = True
        boxes = [box for box in sample.get("boxes", []) if isinstance(box, dict)]
        if cross_talk and len(speakers) >= 2 and len(boxes) >= 2:
            sample["aiCrossTalk"] = True
            continue
        if not boxes or width <= 0 or height <= 0:
            continue
        # Single reported speaker (or crossTalk without enough boxes/speakers
        # to honor a split): match the reported position to the nearest
        # detected box and boost/suppress activity, mirroring the diarization
        # boost in `_associate_speakers_with_tracks`.
        target_x = float(speakers[0]["xRatio"]) * width
        target_y = float(speakers[0]["yRatio"]) * height
        best_box = min(
            boxes, key=lambda box: _distance_to_point(box, target_x, target_y)
        )
        matched_activity = 0.0
        for box in boxes:
            activity = float(box.get("activity", 0.0))
            if box is best_box:
                activity = max(0.85, activity)
                matched_activity = max(matched_activity, activity)
            else:
                activity *= 0.25
            box["activity"] = round(activity, 4)
        sample["activeSpeakerConfidence"] = round(matched_activity, 4)
    if covered_any:
        analysis["activeSpeakerMethod"] = "ai-video-plus-visual-track"


def _distance_to_point(box: Mapping[str, Any], target_x: float, target_y: float) -> float:
    center_x, center_y = _subject_focus(box)
    return (center_x - target_x) ** 2 + (center_y - target_y) ** 2


def fallback_plan(
    clip: Mapping[str, Any], aspect: str, reason: str = "low-confidence"
) -> Dict[str, Any]:
    start, end = float(clip["start"]), float(clip["end"])
    return {
        "clipId": clip["id"],
        "version": COMPOSITION_VERSION,
        "aspectRatio": aspect,
        "framing": dict(FRAMING_PROFILE),
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
    focus_switch_delay_seconds: float = 0.25,
) -> Dict[str, Any]:
    width, height = int(analysis["width"]), int(analysis["height"])
    samples = list(analysis.get("samples") or [])
    if not samples:
        return fallback_plan(clip, aspect)
    raw_detection_rate = float(analysis.get("detectionRate", 0.0))
    usable_flags = [
        any(
            _usable_subject_box(box, width, height)
            for box in list(sample.get("boxes") or [])
        )
        for sample in samples
    ]
    usable_detection_rate = sum(usable_flags) / len(samples)
    detection_rate = min(raw_detection_rate, usable_detection_rate)
    window_rates = _windowed_usable_rates(
        [float(sample.get("time", 0.0)) for sample in samples],
        usable_flags,
        DETECTION_WINDOW_SECONDS,
    )
    if (
        detection_rate < MINIMUM_DETECTION_RATE
        and max(window_rates, default=0.0) < MINIMUM_DETECTION_RATE
    ):
        # Neither the whole clip nor its single best ~2s stretch has reliable
        # detections -- a transient dip alone should not reach this branch,
        # see the per-sample `windowUnreliable` handling below for that case.
        plan = fallback_plan(clip, aspect, "detection-rate")
        plan["source"] = {"width": width, "height": height}
        plan["diagnostics"]["detectionRate"] = round(detection_rate, 4)
        plan["diagnostics"]["rawDetectionRate"] = round(raw_detection_rate, 4)
        plan["diagnostics"]["sampleCount"] = len(samples)
        return plan

    labeled = []
    for index, sample in enumerate(samples):
        boxes = sorted(
            [
                box
                for box in list(sample.get("boxes") or [])
                if _usable_subject_box(box, width, height)
            ],
            key=lambda box: (
                float(box.get("activity", 0.0)),
                float(box.get("confidence", 0.0))
                * float(box.get("width", 0.0))
                * float(box.get("height", 0.0)),
            ),
            reverse=True,
        )
        activity = float(sample.get("activeSpeakerConfidence", 0.0))
        window_unreliable = window_rates[index] < MINIMUM_DETECTION_RATE
        if sample.get("aiCrossTalk") and len(boxes) >= 2:
            # AI-reported cross-talk wins outright: honor the exact window the
            # model returned rather than requiring the sustain window
            # `detect_cross_talk` needs for its noisier, cheaper visual signal.
            layout = "split"
        elif not boxes or window_unreliable:
            layout = "fit"
        elif len(boxes) >= 2 and activity < minimum_confidence:
            layout = "split"
        else:
            layout = "fill"
        primary = boxes[0] if boxes else None
        fill_safe = (
            _fill_is_safe(primary, width, height, aspect)
            if primary is not None
            else False
        )
        fill_fallback = layout == "fill" and not fill_safe
        if fill_fallback:
            layout = "split" if len(boxes) >= 2 else "fit"
        focus_x = (
            _subject_focus(primary)[0]
            if primary
            else float(sample.get("x", width / 2))
        )
        focus_y = (
            _subject_focus(primary)[1]
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
                "fillSafe": fill_safe,
                "framingSafe": layout != "fill" or fill_safe,
                "framingFallback": fill_fallback,
                "windowUnreliable": window_unreliable,
                "aiCovered": bool(sample.get("aiCovered")),
                "activeTrackId": (
                    int(primary["trackId"])
                    if primary and primary.get("trackId") is not None
                    else None
                ),
            }
        )

    labeled = detect_cross_talk(labeled)
    labeled = bridge_safe_fill_gaps(labeled, maximum_seconds=0.5)
    held_detection_gaps = sum(
        1 for value in labeled if value.get("trackingHeld")
    )
    labeled = stabilize_layouts(labeled, minimum_seconds=0.6)
    labeled = enforce_safe_layouts(labeled)
    labeled = stabilize_active_tracks(
        labeled, focus_switch_delay_seconds=focus_switch_delay_seconds
    )
    keyframes = smooth_keyframes(labeled, width, height)
    scenes = _scenes(labeled, keyframes, float(clip["start"]), float(clip["end"]), width, height)
    mean_confidence = sum(float(value["confidence"]) for value in labeled) / len(labeled)
    layout_switches = sum(
        1
        for previous, current in zip(scenes, scenes[1:])
        if previous.get("layout") != current.get("layout")
    )
    focus_switches = sum(
        1
        for previous, current in zip(scenes, scenes[1:])
        if previous.get("activeTrackId") != current.get("activeTrackId")
    )
    framing_fallbacks = sum(
        1 for value in labeled if value.get("framingFallback")
    )
    return {
        "clipId": clip["id"],
        "version": COMPOSITION_VERSION,
        "aspectRatio": aspect,
        "framing": dict(FRAMING_PROFILE),
        "source": {"width": width, "height": height},
        "scenes": scenes,
        "diagnostics": {
            "status": "ready",
            "detectionRate": round(detection_rate, 4),
            "rawDetectionRate": round(raw_detection_rate, 4),
            "trackingConfidence": round(mean_confidence, 4),
            "layoutSwitches": layout_switches,
            "focusSwitches": focus_switches,
            "framingProfile": FRAMING_PROFILE["name"],
            "framingFallbackSamples": framing_fallbacks,
            "heldDetectionGapSamples": held_detection_gaps,
            "detectionWindowSeconds": DETECTION_WINDOW_SECONDS,
            "lowDetectionWindowSamples": sum(
                1 for value in labeled if value.get("windowUnreliable")
            ),
            "crossTalkSamples": sum(
                1 for value in labeled if value.get("crossTalk")
            ),
            "aiSpeakerCoverage": round(
                sum(1 for value in labeled if value.get("aiCovered")) / len(labeled),
                4,
            ),
            "aiCrossTalkSamples": sum(
                1 for sample in samples if sample.get("aiCrossTalk")
            ),
            "sampleCount": len(labeled),
            "sampleSeconds": round(
                max(0.0, labeled[1]["time"] - labeled[0]["time"])
                if len(labeled) > 1
                else 0.0,
                3,
            ),
            "focusSwitchDelaySeconds": round(focus_switch_delay_seconds, 3),
        },
    }


def _fill_is_safe(
    box: Mapping[str, Any],
    source_width: int,
    source_height: int,
    aspect: str,
) -> bool:
    ratio_width, ratio_height = ASPECT_RATIOS.get(aspect, ASPECT_RATIOS["9:16"])
    crop_width, crop_height = crop_dimensions(
        source_width, source_height, ratio_width, ratio_height
    )
    try:
        left = float(box["x"])
        top = float(box["y"])
        box_width = float(box["width"])
        box_height = float(box["height"])
    except (KeyError, TypeError, ValueError):
        return False
    center_x, center_y = _subject_focus(box)
    if str(box.get("subjectKind", "face")) == "person":
        subject_left = left + box_width * 0.2
        subject_top = top
        subject_right = left + box_width * 0.8
        subject_bottom = top + box_height * 0.35
    else:
        subject_left = left
        subject_top = top
        subject_right = left + box_width
        subject_bottom = top + box_height
    crop_x = max(
        0.0,
        min(
            source_width - crop_width,
            center_x - crop_width * float(FRAMING_PROFILE["targetX"]),
        ),
    )
    crop_y = max(
        0.0,
        min(
            source_height - crop_height,
            center_y - crop_height * float(FRAMING_PROFILE["targetFaceY"]),
        ),
    )
    local_center_x = (center_x - crop_x) / crop_width
    local_center_y = (center_y - crop_y) / crop_height
    local_left = (subject_left - crop_x) / crop_width
    local_top = (subject_top - crop_y) / crop_height
    local_right = (subject_right - crop_x) / crop_width
    local_bottom = (subject_bottom - crop_y) / crop_height
    safe_center_x = FRAMING_PROFILE["safeCenterX"]
    safe_center_y = FRAMING_PROFILE["safeCenterY"]
    safe_left, safe_top, safe_right, safe_bottom = FRAMING_PROFILE[
        "safeFaceBounds"
    ]
    return (
        float(safe_center_x[0]) <= local_center_x <= float(safe_center_x[1])
        and float(safe_center_y[0]) <= local_center_y <= float(safe_center_y[1])
        and float(safe_left) <= local_left
        and float(safe_top) <= local_top
        and local_right <= float(safe_right)
        and local_bottom <= float(safe_bottom)
    )


def _subject_focus(box: Mapping[str, Any]) -> tuple[float, float]:
    left = float(box.get("x", 0.0))
    top = float(box.get("y", 0.0))
    width = float(box.get("width", 0.0))
    height = float(box.get("height", 0.0))
    vertical_ratio = 0.2 if str(box.get("subjectKind", "face")) == "person" else 0.45
    return left + width / 2, top + height * vertical_ratio


def _usable_subject_box(
    box: Mapping[str, Any], source_width: int, source_height: int
) -> bool:
    if str(box.get("subjectKind", "face")) != "person":
        return True
    try:
        width = max(0.0, float(box["width"]))
        height = max(0.0, float(box["height"]))
    except (KeyError, TypeError, ValueError):
        return False
    frame_area = max(1.0, float(source_width) * float(source_height))
    return (
        height / max(1.0, float(source_height))
        >= float(FRAMING_PROFILE["minimumPersonHeightRatio"])
        and width * height / frame_area
        >= float(FRAMING_PROFILE["minimumPersonAreaRatio"])
    )


DETECTION_WINDOW_SECONDS = 2.0
MINIMUM_DETECTION_RATE = 0.35


def _windowed_usable_rates(
    times: Sequence[float], usable: Sequence[bool], window_seconds: float
) -> List[float]:
    """Per-sample usable-detection rate over a centered time window, so a transient
    dip only demotes the samples inside that dip, not the whole clip."""
    radius = window_seconds / 2
    rates: List[float] = []
    start = end = 0
    n = len(times)
    for index in range(n):
        while start < n and times[index] - times[start] > radius:
            start += 1
        while end < n - 1 and times[end + 1] - times[index] <= radius:
            end += 1
        window = usable[start : end + 1]
        rates.append(sum(window) / len(window) if window else 0.0)
    return rates


CROSS_TALK_ACTIVITY_FLOOR = 0.45
CROSS_TALK_ACTIVITY_DELTA = 0.2
CROSS_TALK_SUSTAIN_SECONDS = 0.5


def detect_cross_talk(
    samples: Sequence[Mapping[str, Any]],
    *,
    activity_floor: float = CROSS_TALK_ACTIVITY_FLOOR,
    activity_delta: float = CROSS_TALK_ACTIVITY_DELTA,
    sustain_seconds: float = CROSS_TALK_SUSTAIN_SECONDS,
) -> List[Dict[str, Any]]:
    """Force `split` when the two ranked boxes show sustained comparable motion,
    even if the top box alone clears `minimum_confidence`. Pure-visual fallback
    (frame-differencing / lip-region motion from vision.py) -- only fills gaps
    the AI speaker signal (composition.py's `aiCrossTalk`) did not cover."""
    values = [dict(sample) for sample in samples]
    flags = [
        _is_cross_talk_sample(sample, activity_floor, activity_delta)
        for sample in values
    ]
    index = 0
    while index < len(values):
        end = index + 1
        while end < len(values) and flags[end] == flags[index]:
            end += 1
        if flags[index]:
            duration = float(values[end - 1]["time"]) - float(values[index]["time"])
            if duration + 1e-6 >= sustain_seconds:
                for item in range(index, end):
                    values[item]["layout"] = "split"
                    values[item]["crossTalk"] = True
        index = end
    return values


def _is_cross_talk_sample(
    sample: Mapping[str, Any], activity_floor: float, activity_delta: float
) -> bool:
    if sample.get("aiCovered"):
        # The AI speaker signal already had an opinion for this sample; the
        # visual heuristic only reasons about gaps it left uncovered.
        return False
    boxes = list(sample.get("boxes") or [])
    if len(boxes) < 2:
        return False
    top_two = sorted(
        (float(box.get("activity", 0.0)) for box in boxes), reverse=True
    )[:2]
    return (
        top_two[0] >= activity_floor
        and top_two[1] >= activity_floor
        and (top_two[0] - top_two[1]) <= activity_delta
    )


def enforce_safe_layouts(
    samples: Sequence[Mapping[str, Any]],
) -> List[Dict[str, Any]]:
    values = [dict(sample) for sample in samples]
    for sample in values:
        if sample.get("layout") != "fill":
            sample["framingSafe"] = True
            continue
        if bool(sample.get("fillSafe")):
            sample["framingSafe"] = True
            continue
        boxes = list(sample.get("boxes") or [])
        sample["layout"] = "split" if len(boxes) >= 2 else "fit"
        sample["framingSafe"] = True
        sample["framingFallback"] = True
    return values


def bridge_safe_fill_gaps(
    samples: Sequence[Mapping[str, Any]], *, maximum_seconds: float
) -> List[Dict[str, Any]]:
    values = [dict(sample) for sample in samples]
    index = 0
    while index < len(values):
        if values[index].get("boxes") or values[index].get("layout") == "fill":
            index += 1
            continue
        end = index + 1
        while (
            end < len(values)
            and not values[end].get("boxes")
            and values[end].get("layout") != "fill"
        ):
            end += 1
        previous = values[index - 1] if index > 0 else None
        following = values[end] if end < len(values) else None
        same_track = (
            previous is not None
            and following is not None
            and previous.get("activeTrackId") is not None
            and previous.get("activeTrackId") == following.get("activeTrackId")
        )
        continuous = (
            same_track
            and previous.get("layout") == "fill"
            and following.get("layout") == "fill"
            and bool(previous.get("fillSafe"))
            and bool(following.get("fillSafe"))
            and float(following["time"]) - float(previous["time"])
            <= maximum_seconds + 1e-6
        )
        if continuous:
            start_time = float(previous["time"])
            duration = max(0.001, float(following["time"]) - start_time)
            for item in range(index, end):
                progress = (float(values[item]["time"]) - start_time) / duration
                values[item]["layout"] = "fill"
                values[item]["fillSafe"] = True
                values[item]["framingSafe"] = True
                values[item]["framingFallback"] = False
                values[item]["trackingHeld"] = True
                values[item]["activeTrackId"] = previous["activeTrackId"]
                values[item]["focusX"] = float(previous["focusX"]) + (
                    float(following["focusX"]) - float(previous["focusX"])
                ) * progress
                values[item]["focusY"] = float(previous["focusY"]) + (
                    float(following["focusY"]) - float(previous["focusY"])
                ) * progress
                values[item]["confidence"] = min(
                    float(previous["confidence"]),
                    float(following["confidence"]),
                )
        index = end
    return values


def stabilize_active_tracks(
    samples: Sequence[Mapping[str, Any]], *, focus_switch_delay_seconds: float
) -> List[Dict[str, Any]]:
    values = [dict(sample) for sample in samples]
    if len(values) < 2 or focus_switch_delay_seconds <= 0:
        return values
    current = values[0].get("activeTrackId")
    candidate = None
    candidate_since = 0.0
    for sample in values:
        proposed = sample.get("activeTrackId")
        now = float(sample.get("time", 0.0))
        if current is None and proposed is not None:
            current = proposed
            candidate = None
            continue
        if proposed is None or proposed == current:
            candidate = None
            continue
        if proposed != candidate:
            candidate = proposed
            candidate_since = now
        if now - candidate_since + 1e-6 >= focus_switch_delay_seconds:
            current = proposed
            candidate = None
            continue
        current_box = next(
            (
                box
                for box in sample.get("boxes", [])
                if box.get("trackId") == current
            ),
            None,
        )
        if current_box is not None:
            sample["activeTrackId"] = current
            sample["focusX"], sample["focusY"] = _subject_focus(current_box)
        if len(sample.get("boxes", [])) >= 2:
            sample["layout"] = "split"
    return values


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


SPLIT_HSTACK_BIAS = 1.15  # bias toward the proven vstack default unless horizontal
# separation between the two subjects clearly dominates vertical separation.


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
        while (
            end < len(samples)
            and samples[end]["layout"] == samples[index]["layout"]
            and (
                # Both people are shown in a split scene regardless of who is
                # momentarily dominant, so requiring activeTrackId equality here
                # only fragments an otherwise-continuous split into many tiny
                # scenes (each with its own xfade transition -- visible flicker).
                samples[index]["layout"] == "split"
                or samples[end].get("activeTrackId")
                == samples[index].get("activeTrackId")
            )
        ):
            end += 1
        scene_start = clip_start if index == 0 else float(samples[index]["time"])
        scene_end = clip_end if end == len(samples) else float(samples[end]["time"])
        scene_samples = samples[index:end]
        boxes = next((value["boxes"] for value in scene_samples if value.get("boxes")), [])
        # Order by trackId (not momentary activity) so the same physical person
        # keeps rendering in the same split position for as long as their
        # trackId persists, instead of hopping when the activity ranking wobbles.
        ordered_boxes = sorted(
            boxes[:2],
            key=lambda box: (
                box["trackId"] if box.get("trackId") is not None else 10**9
            ),
        )
        subjects = [
            {
                "x": round(_subject_focus(box)[0] / width, 5),
                "y": round(_subject_focus(box)[1] / height, 5),
                "width": round(float(box["width"]) / width, 5),
                "height": round(float(box["height"]) / height, 5),
                "subjectKind": str(box.get("subjectKind", "face")),
                "trackId": (
                    int(box["trackId"]) if box.get("trackId") is not None else None
                ),
            }
            for box in ordered_boxes
        ]
        orientation = "vstack"
        if str(samples[index]["layout"]) == "split" and len(subjects) >= 2:
            dx = abs(subjects[0]["x"] - subjects[1]["x"])
            dy = abs(subjects[0]["y"] - subjects[1]["y"])
            orientation = "hstack" if dx > dy * SPLIT_HSTACK_BIAS else "vstack"
        scenes.append(
            {
                "start": round(max(clip_start, scene_start), 3),
                "end": round(min(clip_end, max(scene_start + 0.04, scene_end)), 3),
                "layout": str(samples[index]["layout"]),
                "orientation": orientation,
                "activeTrackId": samples[index].get("activeTrackId"),
                "confidence": round(
                    sum(float(value["confidence"]) for value in scene_samples)
                    / len(scene_samples),
                    4,
                ),
                "captionSafeZone": "bottom",
                "framingSafe": all(
                    bool(value.get("framingSafe", True)) for value in scene_samples
                ),
                "framingFallback": any(
                    bool(value.get("framingFallback")) for value in scene_samples
                ),
                "keyframes": [dict(value) for value in keyframes[index:end]],
                "subjects": subjects,
            }
        )
        index = end
    return scenes
