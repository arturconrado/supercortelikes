import json
import hashlib
import logging
import re
import time
import urllib.error
import urllib.request
import unicodedata
from typing import Any, Dict, Mapping, Optional, Sequence


logger = logging.getLogger(__name__)

REQUIRED_CATEGORIES = (
    "curiosity",
    "authority",
    "controversy",
    "emotion",
    "business",
    "entertainment",
    "educational",
    "financial",
)


def maybe_score_with_llm(
    segments: Sequence[Mapping[str, Any]],
    lexical_result: Mapping[str, Any],
    settings: Any,
) -> Optional[Dict[str, Any]]:
    if getattr(settings, "llm_provider", "none") != "openrouter":
        return None
    api_key = getattr(settings, "llm_api_key", "")
    if not api_key:
        return None

    payload = _openrouter_payload(segments, lexical_result, settings)
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "authorization": "Bearer %s" % api_key,
            "content-type": "application/json",
            "http-referer": "https://clipbr.ai",
            "x-openrouter-title": "ClipBR AI",
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
            raise ValueError("OpenRouter response must be an object")
        content = body["choices"][0]["message"]["content"]
        value = _json_from_content(content)
        normalized = _normalize_scores(segments, lexical_result, value, payload["model"])
        usage = body.get("usage") if isinstance(body.get("usage"), Mapping) else {}
        cost_usd = _cost(usage)
        normalized["providerUsage"] = [
            {
                "provider": "openrouter",
                "requestId": str(body.get("id") or _response_id(body)),
                "quantity": int(usage.get("total_tokens") or 0),
                "unit": "token",
                "costUsd": round(cost_usd, 6),
                "latencyMs": round((time.monotonic() - started) * 1000),
                "model": payload["model"],
            }
        ]
        return normalized
    except (KeyError, ValueError, TypeError, urllib.error.URLError, TimeoutError) as error:
        logger.warning("OpenRouter scoring failed; using lexical fallback: %s", error)
        return None


def _openrouter_payload(
    segments: Sequence[Mapping[str, Any]],
    lexical_result: Mapping[str, Any],
    settings: Any,
) -> Dict[str, Any]:
    compact_segments = [
        {
            "id": segment.get("id", index),
            "start": segment.get("start", 0),
            "end": segment.get("end", 0),
            "text": str(segment.get("text", ""))[:1800],
            "speakers": segment.get("speakers") or ([segment.get("speaker")] if segment.get("speaker") else []),
            "lexicalScore": lexical_result["scores"][index]["score"],
            "lexicalCategories": lexical_result["scores"][index].get("categories", {}),
            "lexicalSignals": lexical_result["scores"][index].get("signals", {}),
        }
        for index, segment in enumerate(segments[:40])
    ]
    return {
        "model": getattr(settings, "openrouter_editor_model", "") or "google/gemini-2.5-flash",
        "provider": {
            "sort": getattr(settings, "llm_provider_sort", "latency"),
            "require_parameters": True,
            "data_collection": "deny",
        },
        "temperature": 0.2,
        "max_tokens": 2400,
        "usage": {"include": True},
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "system",
                "content": (
                    "Você é um curador de cortes virais para vídeos curtos no Brasil. "
                    "Responda somente JSON válido. Não inclua markdown."
                ),
            },
            {
                "role": "user",
                "content": json.dumps(
                    {
                        "task": (
                            "Score each segment for short-form viral potential and refine its safe spoken boundaries, "
                            "hook, title and one keyword using timestamps and speaker context."
                        ),
                        "requiredShape": {
                            "scores": [
                                {
                                    "segmentId": "same input id",
                                    "score": 0,
                                    "categories": {category: 0 for category in REQUIRED_CATEGORIES},
                                    "signals": {"hook": 0, "retention": 0, "clarity": 0},
                                    "editorial": {
                                        "suggestedStart": "absolute timestamp in seconds",
                                        "suggestedEnd": "absolute timestamp in seconds",
                                        "hook": "short spoken hook, no emoji",
                                        "title": "concise Brazilian Portuguese title, no emoji",
                                        "keyword": "one relevant keyword, no emoji",
                                    },
                                }
                            ]
                        },
                        "segments": compact_segments,
                    },
                    ensure_ascii=False,
                ),
            },
        ],
    }


def _json_from_content(content: str) -> Dict[str, Any]:
    stripped = content.strip()
    if stripped.startswith("```"):
        match = re.search(r"```(?:json)?\s*(.*?)\s*```", stripped, re.S | re.I)
        if match:
            stripped = match.group(1).strip()
    return json.loads(stripped)


def _normalize_scores(
    segments: Sequence[Mapping[str, Any]],
    lexical_result: Mapping[str, Any],
    llm_value: Mapping[str, Any],
    model: str,
) -> Dict[str, Any]:
    lexical_scores = list(lexical_result["scores"])
    raw_scores = list(llm_value.get("scores", []))
    normalized = []
    for index, lexical in enumerate(lexical_scores):
        candidate = raw_scores[index] if index < len(raw_scores) and isinstance(raw_scores[index], Mapping) else {}
        categories = _categories(candidate.get("categories"), lexical["categories"])
        llm_score = _number(candidate.get("score"), lexical["score"])
        blended_score = round((llm_score * 0.7) + (float(lexical["score"]) * 0.3), 2)
        signals = lexical.get("signals", {}).copy()
        if isinstance(candidate.get("signals"), Mapping):
            for key, value in candidate["signals"].items():
                signals[str(key)] = _number(value, 0)
        normalized.append(
            {
                "segmentId": candidate.get("segmentId", segments[index].get("id")),
                "score": max(0.0, min(100.0, blended_score)),
                "categories": categories,
                "signals": signals,
                "editorial": _editorial(candidate.get("editorial"), segments[index]),
            }
        )
    average = round(sum(item["score"] for item in normalized) / len(normalized), 2) if normalized else 0.0
    return {
        "algorithmVersion": "viral-openrouter-v1",
        "llmProvider": "openrouter",
        "llmModel": model,
        "scores": normalized,
        "averageScore": average,
    }


def _categories(value: Any, fallback: Mapping[str, Any]) -> Dict[str, float]:
    source = value if isinstance(value, Mapping) else {}
    return {
        category: _number(source.get(category), fallback.get(category, 0))
        for category in REQUIRED_CATEGORIES
    }


def _number(value: Any, fallback: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    return round(max(0.0, min(100.0, number)), 2)


def _editorial(value: Any, segment: Mapping[str, Any]) -> Dict[str, Any]:
    source = value if isinstance(value, Mapping) else {}
    start = float(segment.get("start", 0))
    end = max(start, float(segment.get("end", start)))
    suggested_start = _timestamp(source.get("suggestedStart"), start, start, end)
    suggested_end = _timestamp(source.get("suggestedEnd"), end, start, end)
    if suggested_end <= suggested_start:
        suggested_start, suggested_end = start, end
    return {
        "suggestedStart": round(suggested_start, 3),
        "suggestedEnd": round(suggested_end, 3),
        "hook": _text(source.get("hook"), 180),
        "title": _text(source.get("title"), 120),
        "keyword": _text(source.get("keyword"), 40),
    }


def _timestamp(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def _text(value: Any, maximum: int) -> str:
    text = re.sub(r"[\r\n\t]+", " ", str(value or "")).strip()
    text = "".join(character for character in text if unicodedata.category(character) != "So")
    return text[:maximum]


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
    return "openrouter-%s" % hashlib.sha256(encoded).hexdigest()[:24]
