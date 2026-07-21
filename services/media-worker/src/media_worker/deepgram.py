import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Mapping, Sequence

from .config import Settings
from .errors import WorkerError


RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def transcribe_url(
    source_url: str, settings: Settings, options: Mapping[str, Any]
) -> Dict[str, Any]:
    if not source_url.startswith(("https://", "http://")):
        raise WorkerError(
            "DEEPGRAM_SOURCE_URL_REQUIRED",
            "Deepgram transcription requires an HTTP(S) source URL",
            status_code=422,
        )
    params = urllib.parse.urlencode(
        {
            "model": str(options.get("model") or settings.deepgram_model),
            "language": str(options.get("language") or settings.deepgram_language),
            "smart_format": "true",
            "utterances": "true",
            "diarize": "true",
            "diarize_model": "v2",
            "mip_opt_out": "true",
        }
    )
    request = urllib.request.Request(
        "https://api.deepgram.com/v1/listen?%s" % params,
        data=json.dumps({"url": source_url}).encode("utf-8"),
        headers={
            "authorization": "Token %s" % settings.deepgram_api_key,
            "content-type": "application/json",
            "user-agent": "PicaShorts-Media-Worker/1.0",
        },
        method="POST",
    )
    started = time.monotonic()
    payload = _request_json(request, settings.deepgram_timeout_seconds)
    try:
        metadata = payload.get("metadata") or {}
        results = payload["results"]
        alternative = results["channels"][0]["alternatives"][0]
    except (KeyError, IndexError, TypeError) as error:
        raise WorkerError(
            "DEEPGRAM_RESPONSE_INVALID",
            "Deepgram returned an invalid transcription response",
            status_code=502,
        ) from error
    words = _normalize_words(alternative.get("words") or [])
    segments = _segments(results.get("utterances") or [], words)
    if not segments:
        raise WorkerError("TRANSCRIPT_EMPTY", "Deepgram returned no speech segments")
    confidence_values = [
        float(word["confidence"])
        for word in words
        if word.get("confidence") is not None
    ]
    confidence = (
        sum(confidence_values) / len(confidence_values)
        if confidence_values
        else float(alternative.get("confidence") or 0.0)
    )
    duration = float(metadata.get("duration") or max(segment["end"] for segment in segments))
    request_id = str(metadata.get("request_id") or metadata.get("requestId") or "deepgram-unknown")
    cost_usd = round(duration / 3600.0 * settings.deepgram_cost_usd_per_hour, 6)
    return {
        "engine": "deepgram",
        "model": str(options.get("model") or settings.deepgram_model),
        "language": str(options.get("language") or settings.deepgram_language),
        "confidence": round(confidence, 5),
        "durationSeconds": round(duration, 3),
        "speakerCount": len({word["speaker"] for word in words if word.get("speaker")}),
        "segments": segments,
        "providerUsage": [
            {
                "provider": "deepgram",
                "requestId": request_id,
                "quantity": round(duration, 3),
                "unit": "second",
                "costUsd": cost_usd,
                "latencyMs": round((time.monotonic() - started) * 1000),
                "model": str(options.get("model") or settings.deepgram_model),
            }
        ],
    }


def _request_json(request: urllib.request.Request, timeout: int) -> Dict[str, Any]:
    last_error: BaseException | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("Deepgram response must be an object")
            return value
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in RETRYABLE_STATUS or attempt == 2:
                detail = _safe_http_body(error)
                raise WorkerError(
                    "DEEPGRAM_RATE_LIMITED" if error.code == 429 else "DEEPGRAM_FAILED",
                    "Deepgram transcription failed",
                    status_code=503 if error.code in RETRYABLE_STATUS else 502,
                    detail={"status": error.code, "response": detail},
                ) from error
            delay = _retry_after(error, attempt)
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            if attempt == 2:
                break
            delay = float(2**attempt)
        time.sleep(delay)
    raise WorkerError(
        "DEEPGRAM_UNAVAILABLE",
        "Deepgram transcription is unavailable",
        status_code=503,
        detail={"reason": str(last_error)[:200] if last_error else "unknown"},
    ) from last_error


def _retry_after(error: urllib.error.HTTPError, attempt: int) -> float:
    try:
        value = float(error.headers.get("retry-after", ""))
        return max(0.25, min(10.0, value))
    except (TypeError, ValueError):
        return float(2**attempt)


def _safe_http_body(error: urllib.error.HTTPError) -> str:
    try:
        return error.read(500).decode("utf-8", errors="replace").replace("\n", " ")
    except BaseException:
        return ""


def _normalize_words(values: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    words: List[Dict[str, Any]] = []
    for value in values:
        if value.get("start") is None or value.get("end") is None:
            continue
        speaker_value = value.get("speaker")
        speaker = "SPEAKER_%02d" % int(speaker_value) if speaker_value is not None else None
        words.append(
            {
                "word": str(value.get("punctuated_word") or value.get("word") or "").strip(),
                "start": round(float(value["start"]), 3),
                "end": round(float(value["end"]), 3),
                "confidence": _optional_float(value.get("confidence")),
                "speaker": speaker,
                "speakerConfidence": _optional_float(value.get("speaker_confidence")),
            }
        )
    return words


def _segments(
    utterances: Sequence[Mapping[str, Any]], words: Sequence[Mapping[str, Any]]
) -> List[Dict[str, Any]]:
    if utterances:
        normalized = []
        for index, value in enumerate(utterances):
            start = float(value.get("start") or 0.0)
            end = float(value.get("end") or start)
            contained = [
                dict(word)
                for word in words
                if float(word["start"]) >= start - 0.02 and float(word["end"]) <= end + 0.02
            ]
            speaker_value = value.get("speaker")
            speaker = "SPEAKER_%02d" % int(speaker_value) if speaker_value is not None else None
            normalized.append(
                {
                    "id": index,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "text": str(value.get("transcript") or " ".join(word["word"] for word in contained)).strip(),
                    "speaker": speaker,
                    "words": contained,
                }
            )
        return [segment for segment in normalized if segment["end"] > segment["start"] and segment["text"]]
    if not words:
        return []
    groups: List[List[Mapping[str, Any]]] = []
    for word in words:
        if not groups:
            groups.append([word])
            continue
        previous = groups[-1][-1]
        if word.get("speaker") != previous.get("speaker") or float(word["start"]) - float(previous["end"]) > 0.8:
            groups.append([word])
        else:
            groups[-1].append(word)
    return [
        {
            "id": index,
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": " ".join(str(word["word"]) for word in group).strip(),
            "speaker": group[0].get("speaker"),
            "words": [dict(word) for word in group],
        }
        for index, group in enumerate(groups)
    ]


def _optional_float(value: Any) -> Any:
    return None if value is None else round(float(value), 5)
