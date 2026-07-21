import base64
import hashlib
import json
import logging
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

from .process import run_command


logger = logging.getLogger(__name__)


def review_renders(
    renders: Sequence[Mapping[str, Any]],
    settings: Any,
    output_dir: Path,
    *,
    cost_remaining_usd: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    if not getattr(settings, "openrouter_qa_enabled", False):
        return None
    if getattr(settings, "llm_provider", "none") != "openrouter":
        return None
    api_key = str(getattr(settings, "llm_api_key", "") or "")
    if not api_key or (cost_remaining_usd is not None and cost_remaining_usd <= 0):
        return None
    sheets = []
    for render in renders:
        path = Path(str(render.get("path") or ""))
        if not path.is_file():
            continue
        clip_id = str(render.get("clipId") or "")
        duration = max(0.1, float(render.get("durationSeconds") or 0.1))
        try:
            sheet = _contact_sheet(path, clip_id, duration, output_dir, settings)
        except Exception as error:
            logger.warning("Visual QA contact sheet failed; preserving the render: %s", error)
            return None
        sheets.append((clip_id, sheet))
    if not sheets:
        return None

    content = [{
        "type": "text",
        "text": json.dumps(
            {
                "task": "Inspect each six-frame contact sheet from a social video render.",
                "failWhen": [
                    "face is cut by frame edge",
                    "speaking subject is outside the central safe area",
                    "captions cover the mouth or face",
                    "unintended black bars are visible",
                    "focus changes to an obviously wrong subject",
                ],
                "response": {
                    "reviews": [{
                        "clipId": "exact supplied clip id",
                        "passed": True,
                        "issues": ["face_cut|subject_unsafe|caption_on_face|black_bars|wrong_focus"],
                        "confidence": 0.0,
                    }]
                },
                "rules": "Return JSON only. Be conservative. Do not invent issues that are not visible.",
            },
            ensure_ascii=False,
        ),
    }]
    for clip_id, path in sheets:
        content.extend([
            {"type": "text", "text": "clipId=%s" % clip_id},
            {
                "type": "image_url",
                "image_url": {
                    "url": "data:image/jpeg;base64,%s" % base64.b64encode(path.read_bytes()).decode("ascii")
                },
            },
        ])
    payload = {
        "model": getattr(settings, "openrouter_editor_model", "") or "google/gemini-2.5-flash",
        "provider": {
            "sort": getattr(settings, "llm_provider_sort", "latency"),
            "require_parameters": True,
            "data_collection": "deny",
        },
        "temperature": 0,
        "max_tokens": 1400,
        "usage": {"include": True},
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": content}],
    }
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "authorization": "Bearer %s" % api_key,
            "content-type": "application/json",
            "http-referer": "https://picashorts.com",
            "x-openrouter-title": "PicaShorts Production QA",
        },
        method="POST",
    )
    started = time.monotonic()
    try:
        with urllib.request.urlopen(
            request, timeout=int(getattr(settings, "llm_timeout_seconds", 45))
        ) as response:
            body = json.loads(response.read().decode("utf-8"))
        if not isinstance(body, Mapping):
            raise ValueError("OpenRouter QA response must be an object")
        raw = _json_content(body["choices"][0]["message"]["content"])
        reviews = _reviews(raw, [value[0] for value in sheets])
        usage = body.get("usage") if isinstance(body.get("usage"), Mapping) else {}
        return {
            "reviews": reviews,
            "failedClipIds": [value["clipId"] for value in reviews if not value["passed"]],
            "providerUsage": [{
                "provider": "openrouter",
                "requestId": str(body.get("id") or _response_id(body)),
                "quantity": int(usage.get("total_tokens") or 0),
                "unit": "token",
                "costUsd": round(_cost(usage), 6),
                "latencyMs": round((time.monotonic() - started) * 1000),
                "model": payload["model"],
            }],
        }
    except (KeyError, TypeError, ValueError, TimeoutError, urllib.error.URLError) as error:
        logger.warning("OpenRouter visual QA failed; preserving the render: %s", error)
        return None


def conservative_compositions(
    plans: Mapping[str, Mapping[str, Any]], failed_clip_ids: Sequence[str]
) -> Dict[str, Mapping[str, Any]]:
    failed = set(failed_clip_ids)
    result: Dict[str, Mapping[str, Any]] = {}
    for clip_id, plan in plans.items():
        if clip_id not in failed:
            result[clip_id] = plan
            continue
        value = dict(plan)
        value["scenes"] = [
            {**dict(scene), "layout": "fit", "keyframes": []}
            for scene in plan.get("scenes", [])
            if isinstance(scene, Mapping)
        ]
        diagnostics = dict(value.get("diagnostics") or {})
        diagnostics.update({"status": "fallback", "reason": "visual-qa-rerender"})
        value["diagnostics"] = diagnostics
        result[clip_id] = value
    return result


def _contact_sheet(path: Path, clip_id: str, duration: float, output_dir: Path, settings: Any) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / (re.sub(r"[^a-zA-Z0-9_-]", "-", clip_id) + ".jpg")
    run_command(
        [
            str(getattr(settings, "ffmpeg_binary", "ffmpeg")),
            "-y",
            "-i",
            str(path),
            "-vf",
            "fps=%.8f,scale=320:-2:flags=lanczos,tile=3x2:padding=4:margin=4" % (6.0 / duration),
            "-frames:v",
            "1",
            "-q:v",
            "5",
            str(destination),
        ],
        timeout=180,
    )
    return destination


def _json_content(content: str) -> Dict[str, Any]:
    value = content.strip()
    if value.startswith("```"):
        match = re.search(r"```(?:json)?\s*(.*?)\s*```", value, re.S | re.I)
        if match:
            value = match.group(1)
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise ValueError("QA response must be an object")
    return parsed


def _reviews(value: Mapping[str, Any], clip_ids: Sequence[str]) -> list:
    allowed = {"face_cut", "subject_unsafe", "caption_on_face", "black_bars", "wrong_focus"}
    raw = value.get("reviews") if isinstance(value.get("reviews"), list) else []
    by_id = {
        str(item.get("clipId")): item
        for item in raw
        if isinstance(item, Mapping) and str(item.get("clipId")) in clip_ids
    }
    reviews = []
    for clip_id in clip_ids:
        item = by_id.get(clip_id, {})
        issues = [str(issue) for issue in item.get("issues", []) if str(issue) in allowed]
        reviews.append({
            "clipId": clip_id,
            "passed": bool(item.get("passed", not issues)) and not issues,
            "issues": issues,
            "confidence": max(0.0, min(1.0, float(item.get("confidence") or 0.0))),
        })
    return reviews


def _cost(usage: Mapping[str, Any]) -> float:
    for key in ("cost", "total_cost", "totalCost"):
        if key not in usage:
            continue
        try:
            return max(0.0, float(usage.get(key) or 0.0))
        except (TypeError, ValueError):
            continue
    return 0.0


def _response_id(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return "openrouter-qa-%s" % hashlib.sha256(encoded).hexdigest()[:24]
