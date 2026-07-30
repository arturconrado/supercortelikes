import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

from .openrouter_video import (
    OpenRouterVideoError,
    analyze_video,
    create_proxy,
    enabled as openrouter_video_enabled,
    video_model,
)
from .process import run_command


logger = logging.getLogger(__name__)


def review_renders(
    renders: Sequence[Mapping[str, Any]],
    settings: Any,
    output_dir: Path,
    *,
    cost_remaining_usd: Optional[float] = None,
    composition_plans: Optional[Mapping[str, Mapping[str, Any]]] = None,
) -> Optional[Dict[str, Any]]:
    if not getattr(settings, "openrouter_qa_enabled", False):
        return None
    reviews = []
    provider_usage = []
    provider_available = openrouter_video_enabled(settings)
    remaining = cost_remaining_usd
    for render in renders:
        path = Path(str(render.get("path") or ""))
        if not path.is_file():
            continue
        clip_id = str(render.get("clipId") or "")
        technical = _technical_review(path, settings)
        model_review = None
        unavailable_reason = ""
        if remaining is not None and remaining <= 0:
            unavailable_reason = "cost-budget-exhausted"
        elif not provider_available:
            unavailable_reason = "openrouter-video-unavailable"
        else:
            try:
                proxy = create_proxy(
                    path,
                    output_dir,
                    settings,
                    clip_id=clip_id,
                )
                if proxy is None:
                    unavailable_reason = "proxy-size-limit"
                else:
                    prompt = _review_prompt(
                        clip_id,
                        render,
                        technical,
                        (composition_plans or {}).get(clip_id),
                    )
                    last_model_error: Optional[BaseException] = None
                    for model_attempt in range(2):
                        if remaining is not None and remaining <= 0:
                            unavailable_reason = "cost-budget-exhausted"
                            break
                        try:
                            result = analyze_video(
                                proxy,
                                prompt,
                                settings,
                                max_tokens=2400,
                            )
                            provider_usage.append(result["usage"])
                            if remaining is not None:
                                remaining = max(
                                    0.0,
                                    remaining
                                    - float(result["usage"].get("costUsd") or 0.0),
                                )
                            model_review = _reviews(
                                _json_content(result["content"]), [clip_id]
                            )[0]
                            if model_review.get("reviewed"):
                                break
                            model_review = None
                            unavailable_reason = "model-review-missing"
                        except (
                            json.JSONDecodeError,
                            OpenRouterVideoError,
                            ValueError,
                        ) as error:
                            last_model_error = error
                            model_review = None
                            unavailable_reason = type(error).__name__
                            if model_attempt == 0:
                                continue
                            raise
                    if model_review is None and last_model_error is not None:
                        logger.warning(
                            "OpenRouter video QA did not produce a valid review for %s: %s",
                            clip_id,
                            last_model_error,
                        )
            except (OSError, RuntimeError, ValueError, OpenRouterVideoError) as error:
                unavailable_reason = type(error).__name__
                logger.warning(
                    "OpenRouter video QA failed for %s; marking it unverified: %s",
                    clip_id,
                    error,
                )

        technical_issues = list(technical.get("issues") or [])
        if model_review is None:
            issues = technical_issues
            passed = False
            verified = False
            confidence = float(technical.get("confidence") or 0.0)
            reasons = [unavailable_reason] if unavailable_reason else []
            corrections = []
        else:
            issues = list(dict.fromkeys(technical_issues + list(model_review["issues"])))
            model_confidence = float(model_review["confidence"])
            verified = (
                technical.get("status") != "unverified"
                and model_confidence >= 0.65
            )
            passed = bool(model_review["passed"]) and not issues and verified
            confidence = min(
                model_confidence,
                float(technical.get("confidence") or 1.0),
            )
            reasons = list(model_review.get("reasons") or [])
            if model_confidence < 0.65:
                reasons.append("model-confidence-below-threshold")
            corrections = list(model_review.get("corrections") or [])
        reviews.append(
            {
                "clipId": clip_id,
                "passed": passed,
                "verified": verified,
                "issues": issues,
                "confidence": round(max(0.0, min(1.0, confidence)), 4),
                "reasons": reasons,
                "corrections": corrections,
                "technical": technical,
            }
        )

    if not reviews:
        return None
    failed_clip_ids = [
        value["clipId"]
        for value in reviews
        if (
            value["issues"]
            or
            (value["verified"] and not value["passed"])
            or value["technical"].get("hardFailure")
        )
    ]
    if failed_clip_ids:
        status = "REVIEW_REQUIRED"
    elif any(not value["verified"] for value in reviews):
        status = "UNVERIFIED"
    else:
        status = "PASSED"
    return {
        "status": status,
        "reviews": reviews,
        "failedClipIds": failed_clip_ids,
        "providerUsage": provider_usage,
        "attempts": 1,
        "model": video_model(settings) if provider_available else None,
        "reviewedAt": datetime.now(timezone.utc).isoformat(),
    }


def _review_prompt(
    clip_id: str,
    render: Mapping[str, Any],
    technical: Mapping[str, Any],
    composition_plan: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "task": (
            "Review the supplied social-video MP4 as a temporal sequence with audio. "
            "Verify that the visible crop follows the person who is actually speaking, "
            "that switches happen on time, that the speaker stays cleanly centered with "
            "professional headroom, and that audio and lip motion stay synchronized."
        ),
        "clip": {
            "clipId": clip_id,
            "durationSeconds": render.get("durationSeconds"),
            "technicalTiming": technical,
            "composition": _compact_composition(composition_plan),
        },
        "failWhen": [
            "wrong_speaker: crop follows a non-speaking person",
            "late_switch: crop changes more than 400ms after the speaker",
            "subject_unsafe: speaking subject leaves the central safe area",
            "face_cut: a face is cut by the frame edge",
            "caption_on_face: captions cover a mouth or face",
            "black_bars: unintended black bars are visible",
            "av_sync: sound and lip motion are detectably out of sync",
            "stream_timing: visible freeze, missing audio, or timing discontinuity",
        ],
        "response": {
            "reviews": [
                {
                    "clipId": clip_id,
                    "passed": True,
                    "issues": ["wrong_speaker"],
                    "confidence": 0.0,
                    "reasons": ["short objective reason"],
                    "corrections": [
                        {
                            "startMs": 0,
                            "endMs": 0,
                            "layout": "split",
                            "activeTrackId": 1,
                            "reason": "short correction reason",
                        }
                    ],
                }
            ]
        },
        "rules": (
            "Return JSON only. Evaluate the whole video, not isolated frames. "
            "Do not mark passed when any listed issue is present. A fit scene with no "
            "supplied tracks is intentional B-roll: an off-screen voice over product "
            "footage is not wrong_speaker, and a tiny background person must not drive "
            "the crop. Never invent or reuse a track from another scene. When choosing "
            "fill, set activeTrackId to a track supplied for that exact time range."
        ),
    }


def _compact_composition(plan: Optional[Mapping[str, Any]]) -> Any:
    if not isinstance(plan, Mapping):
        return None
    scenes = plan.get("scenes") if isinstance(plan.get("scenes"), list) else []
    valid_scenes = [scene for scene in scenes if isinstance(scene, Mapping)]
    base_seconds = min(
        (float(scene.get("start", 0.0)) for scene in valid_scenes),
        default=0.0,
    )
    return {
        "version": plan.get("version"),
        "aspectRatio": plan.get("aspectRatio"),
        "framing": plan.get("framing"),
        "scenes": [
            {
                "startMs": round((float(scene.get("start", base_seconds)) - base_seconds) * 1000),
                "endMs": round((float(scene.get("end", base_seconds)) - base_seconds) * 1000),
                "layout": scene.get("layout"),
                "activeTrackId": scene.get("activeTrackId"),
                "framingSafe": scene.get("framingSafe"),
                "framingFallback": scene.get("framingFallback"),
                "tracks": [
                    subject.get("trackId")
                    for subject in (
                        scene.get("subjects")
                        if isinstance(scene.get("subjects"), list)
                        else []
                    )
                    if isinstance(subject, Mapping) and subject.get("trackId") is not None
                ],
                "subjects": [
                    {
                        "trackId": subject.get("trackId"),
                        "x": subject.get("x"),
                        "y": subject.get("y"),
                    }
                    for subject in (
                        scene.get("subjects")
                        if isinstance(scene.get("subjects"), list)
                        else []
                    )
                    if isinstance(subject, Mapping)
                ],
            }
            for scene in valid_scenes[:80]
        ],
    }


def _technical_review(path: Path, settings: Any) -> Dict[str, Any]:
    try:
        value = run_command(
            [
                str(getattr(settings, "ffprobe_binary", "ffprobe")),
                "-v",
                "error",
                "-show_entries",
                "stream=codec_type,start_time,duration:format=start_time,duration",
                "-of",
                "json",
                str(path),
            ],
            timeout=60,
            capture_json=True,
        )
        streams = value.get("streams") if isinstance(value, Mapping) else []
        streams = streams if isinstance(streams, list) else []
        video = next(
            (item for item in streams if item.get("codec_type") == "video"), None
        )
        audio = next(
            (item for item in streams if item.get("codec_type") == "audio"), None
        )
        if not isinstance(video, Mapping):
            return {
                "status": "failed",
                "hardFailure": True,
                "issues": ["stream_timing"],
                "confidence": 1.0,
                "reason": "video-stream-missing",
            }
        issues = []
        video_start = _number(video.get("start_time"), 0.0)
        audio_start = _number(audio.get("start_time"), video_start) if audio else None
        video_duration = _number(video.get("duration"), None)
        audio_duration = _number(audio.get("duration"), None) if audio else None
        start_delta_ms = (
            abs(video_start - audio_start) * 1000 if audio_start is not None else None
        )
        duration_delta_ms = (
            abs(video_duration - audio_duration) * 1000
            if video_duration is not None and audio_duration is not None
            else None
        )
        if start_delta_ms is not None and start_delta_ms > 40:
            issues.append("av_sync")
        if duration_delta_ms is not None and duration_delta_ms > 80:
            issues.append("stream_timing")
        return {
            "status": "failed" if issues else "passed",
            "hardFailure": bool(issues),
            "issues": issues,
            "confidence": 1.0,
            "videoStartMs": round(video_start * 1000, 3),
            "audioStartMs": round(audio_start * 1000, 3) if audio_start is not None else None,
            "startDeltaMs": round(start_delta_ms, 3) if start_delta_ms is not None else None,
            "durationDeltaMs": (
                round(duration_delta_ms, 3) if duration_delta_ms is not None else None
            ),
        }
    except Exception as error:
        logger.warning("Technical A/V timing probe failed for %s: %s", path, error)
        return {
            "status": "unverified",
            "hardFailure": False,
            "issues": [],
            "confidence": 0.0,
            "reason": "ffprobe-unavailable",
        }


def _number(value: Any, default: Any) -> Any:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def conservative_compositions(
    plans: Mapping[str, Mapping[str, Any]], failed_clip_ids: Sequence[str]
) -> Dict[str, Mapping[str, Any]]:
    return corrected_compositions(
        plans,
        [
            {
                "clipId": clip_id,
                "issues": ["subject_unsafe"],
                "corrections": [],
            }
            for clip_id in failed_clip_ids
        ],
    )


def merge_rerender_quality(
    initial: Mapping[str, Any],
    rerender: Mapping[str, Any],
    rerendered_clip_ids: Sequence[str],
) -> Dict[str, Any]:
    rerendered = {str(value) for value in rerendered_clip_ids}
    reviews = {
        str(value.get("clipId")): dict(value)
        for value in initial.get("reviews", [])
        if isinstance(value, Mapping) and value.get("clipId")
    }
    for value in rerender.get("reviews", []):
        if isinstance(value, Mapping) and value.get("clipId"):
            reviews[str(value["clipId"])] = dict(value)
    failed = {
        str(value)
        for value in initial.get("failedClipIds", [])
        if str(value) not in rerendered
    }
    failed.update(str(value) for value in rerender.get("failedClipIds", []))
    review_values = list(reviews.values())
    if failed:
        status = "REVIEW_REQUIRED"
    elif any(not value.get("verified") for value in review_values):
        status = "UNVERIFIED"
    else:
        status = "PASSED"
    return {
        **dict(rerender),
        "status": status,
        "reviews": review_values,
        "failedClipIds": sorted(failed),
        "providerUsage": list(initial.get("providerUsage", []))
        + list(rerender.get("providerUsage", [])),
        "rerendered": sorted(rerendered),
        "attempts": 2,
    }


def corrected_compositions(
    plans: Mapping[str, Mapping[str, Any]],
    reviews: Sequence[Mapping[str, Any]],
) -> Dict[str, Mapping[str, Any]]:
    by_id = {
        str(review.get("clipId")): review
        for review in reviews
        if isinstance(review, Mapping)
    }
    result: Dict[str, Mapping[str, Any]] = {}
    for clip_id, plan in plans.items():
        review = by_id.get(clip_id)
        if review is None:
            result[clip_id] = plan
            continue
        issues = {str(value) for value in review.get("issues", [])}
        value = dict(plan)
        corrected_scenes = []
        plan_start = min(
            (
                float(scene.get("start", 0.0))
                for scene in plan.get("scenes", [])
                if isinstance(scene, Mapping)
            ),
            default=0.0,
        )
        for scene in plan.get("scenes", []):
            if not isinstance(scene, Mapping):
                continue
            scene_value = dict(scene)
            correction = _suggested_correction(
                scene, review.get("corrections"), plan_start=plan_start
            )
            if correction:
                scene_value["layout"] = correction["layout"]
                if correction.get("activeTrackId") is not None:
                    scene_value["activeTrackId"] = correction["activeTrackId"]
            elif issues.intersection({"wrong_speaker", "late_switch"}):
                scene_value["layout"] = (
                    "split" if len(scene.get("subjects") or []) >= 2 else "fit"
                )
            else:
                scene_value["layout"] = "fit"
            if scene_value["layout"] == "fill" and correction:
                keyframes = _track_keyframes(
                    scene,
                    correction.get("activeTrackId"),
                    plan.get("source"),
                )
                if keyframes:
                    scene_value["keyframes"] = keyframes
                else:
                    scene_value["layout"] = (
                        "split" if len(scene.get("subjects") or []) >= 2 else "fit"
                    )
                    scene_value["keyframes"] = []
            else:
                scene_value["keyframes"] = (
                    list(scene.get("keyframes") or [])
                    if scene_value["layout"] == "fill"
                    else []
                )
            corrected_scenes.append(scene_value)
        value["scenes"] = corrected_scenes
        diagnostics = dict(value.get("diagnostics") or {})
        diagnostics.update(
            {
                "status": "fallback",
                "reason": "video-qa-rerender",
                "qualityIssues": sorted(issues),
            }
        )
        value["diagnostics"] = diagnostics
        result[clip_id] = value
    return result


def _suggested_correction(
    scene: Mapping[str, Any], corrections: Any, *, plan_start: float = 0.0
) -> Optional[Mapping[str, Any]]:
    if not isinstance(corrections, list):
        return None
    scene_start_ms = (float(scene.get("start", plan_start)) - plan_start) * 1000
    scene_end_ms = (float(scene.get("end", plan_start)) - plan_start) * 1000
    for correction in corrections:
        if not isinstance(correction, Mapping):
            continue
        try:
            start_ms = float(correction.get("startMs", scene_start_ms))
            end_ms = float(correction.get("endMs", scene_end_ms))
        except (TypeError, ValueError):
            continue
        layout = str(correction.get("layout") or "")
        if layout in {"fill", "split", "fit"} and start_ms < scene_end_ms and end_ms > scene_start_ms:
            return correction
    return None


def _track_keyframes(
    scene: Mapping[str, Any],
    active_track_id: Any,
    source: Any,
) -> list:
    if active_track_id is None or not isinstance(source, Mapping):
        return []
    subjects = scene.get("subjects") if isinstance(scene.get("subjects"), list) else []
    subject = next(
        (
            value
            for value in subjects
            if isinstance(value, Mapping)
            and _integer(value.get("trackId")) == _integer(active_track_id)
        ),
        None,
    )
    if subject is None:
        return []
    try:
        width = float(source["width"])
        height = float(source["height"])
        x = max(0.0, min(width, float(subject["x"]) * width))
        y = max(0.0, min(height, float(subject["y"]) * height))
        start = float(scene.get("start", 0.0))
        end = float(scene.get("end", start))
    except (KeyError, TypeError, ValueError):
        return []
    return [
        {"time": round(start, 3), "x": round(x, 2), "y": round(y, 2), "confidence": 0.9},
        {"time": round(end, 3), "x": round(x, 2), "y": round(y, 2), "confidence": 0.9},
    ]


def _json_content(content: str) -> Dict[str, Any]:
    value = content.strip()
    for _attempt in range(3):
        if value.startswith("```"):
            match = re.search(r"```(?:json)?\s*(.*?)\s*```", value, re.S | re.I)
            if match:
                value = match.group(1)
        parsed = json.loads(value)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list):
            return {"reviews": parsed}
        if isinstance(parsed, str):
            value = parsed.strip()
            continue
        break
    raise ValueError("QA response must be an object, review list, or encoded JSON")


def _reviews(value: Mapping[str, Any], clip_ids: Sequence[str]) -> list:
    allowed = {
        "wrong_speaker",
        "late_switch",
        "subject_unsafe",
        "face_cut",
        "caption_on_face",
        "black_bars",
        "av_sync",
        "stream_timing",
    }
    raw = value.get("reviews") if isinstance(value.get("reviews"), list) else []
    by_id = {
        str(item.get("clipId")): item
        for item in raw
        if isinstance(item, Mapping) and str(item.get("clipId")) in clip_ids
    }
    reviews = []
    for clip_id in clip_ids:
        item = by_id.get(clip_id)
        if item is None:
            reviews.append(
                {
                    "clipId": clip_id,
                    "passed": False,
                    "reviewed": False,
                    "issues": [],
                    "confidence": 0.0,
                    "reasons": ["model-review-missing"],
                    "corrections": [],
                }
            )
            continue
        raw_issues = item.get("issues") if isinstance(item.get("issues"), list) else []
        issues = [str(issue) for issue in raw_issues if str(issue) in allowed]
        unknown_issues = [
            str(issue)
            for issue in raw_issues
            if str(issue).strip() and str(issue) not in allowed
        ]
        raw_reasons = item.get("reasons") if isinstance(item.get("reasons"), list) else []
        reasons = [
            str(reason)[:240]
            for reason in raw_reasons
            if isinstance(reason, str) and reason.strip()
        ][:8]
        if unknown_issues:
            reasons.append("model-returned-unknown-issue")
        corrections = []
        raw_corrections = (
            item.get("corrections")
            if isinstance(item.get("corrections"), list)
            else []
        )
        for correction in raw_corrections:
            if not isinstance(correction, Mapping):
                continue
            layout = str(correction.get("layout") or "")
            if layout not in {"fill", "split", "fit"}:
                continue
            try:
                start_ms = max(0, int(float(correction.get("startMs") or 0)))
                end_ms = max(start_ms, int(float(correction.get("endMs") or start_ms)))
            except (TypeError, ValueError):
                continue
            corrections.append(
                {
                    "startMs": start_ms,
                    "endMs": end_ms,
                    "layout": layout,
                    "activeTrackId": _integer(correction.get("activeTrackId")),
                    "reason": str(correction.get("reason") or "")[:240],
                }
            )
        reviews.append({
            "clipId": clip_id,
            "passed": item.get("passed") is True and not issues and not unknown_issues,
            "reviewed": True,
            "issues": issues,
            "confidence": max(0.0, min(1.0, _number(item.get("confidence"), 0.0))),
            "reasons": reasons,
            "corrections": corrections[:12],
        })
    return reviews


def _integer(value: Any) -> Any:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None
