from __future__ import annotations

import base64
import json
import logging
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple

from .config import Settings
from .errors import WorkerError
from .process import run_command


logger = logging.getLogger(__name__)

OPENROUTER_TRANSCRIPTIONS_URL = "https://openrouter.ai/api/v1/audio/transcriptions"
RETRYABLE_STATUS = {429, 502, 503, 504}
MODEL_UNAVAILABLE_STATUS = {404, 422}
LANGUAGE_NAMES = {
    "english": "en",
    "portuguese": "pt",
    "spanish": "es",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "japanese": "ja",
    "korean": "ko",
    "chinese": "zh",
}


def transcribe_file(
    source: Path, settings: Settings, options: Mapping[str, Any]
) -> Dict[str, Any]:
    if not source.is_file() or source.stat().st_size <= 0:
        raise WorkerError(
            "OPENROUTER_STT_SOURCE_REQUIRED",
            "OpenRouter transcription requires a non-empty local media file",
            status_code=422,
        )
    if not settings.llm_api_key:
        raise WorkerError(
            "OPENROUTER_STT_KEY_REQUIRED",
            "OpenRouter transcription requires LLM_API_KEY",
            status_code=503,
        )

    primary_model = str(options.get("model") or settings.openrouter_stt_model).strip()
    fallback_model = str(settings.openrouter_stt_fallback_model).strip()
    models = [primary_model]
    if fallback_model and fallback_model != primary_model:
        models.append(fallback_model)
    language = _language_code(
        str(options.get("language") or settings.openrouter_stt_language)
    )
    chunk_seconds = max(
        60,
        min(
            900,
            int(options.get("chunkSeconds") or settings.openrouter_stt_chunk_seconds),
        ),
    )

    with tempfile.TemporaryDirectory(
        prefix="openrouter-stt-", dir=str(source.parent)
    ) as temporary:
        chunks = _extract_chunks(source, Path(temporary), settings, chunk_seconds)
        offsets = _chunk_offsets(chunks, settings)
        results = _transcribe_chunks(
            offsets,
            models,
            language,
            settings,
        )

    segments: List[Dict[str, Any]] = []
    provider_usage: List[Dict[str, Any]] = []
    languages: List[str] = []
    models_used: List[str] = []
    for result in results:
        languages.append(str(result.get("language") or language or "unknown"))
        models_used.append(str(result.get("model") or primary_model))
        provider_usage.extend(result.get("providerUsage", []))
        segments.extend(result.get("segments", []))
    for index, segment in enumerate(segments):
        segment["id"] = index
    if not segments:
        raise WorkerError("TRANSCRIPT_EMPTY", "OpenRouter returned no speech segments")
    confidence_values = [
        float(word["confidence"])
        for segment in segments
        for word in segment.get("words", [])
        if word.get("confidence") is not None
    ]
    confidence = (
        sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    )
    return {
        "engine": "openrouter",
        "model": models_used[0]
        if len(set(models_used)) == 1
        else "+".join(sorted(set(models_used))),
        "language": _majority(languages, language or "unknown"),
        "confidence": round(confidence, 5),
        "durationSeconds": round(max(float(segment["end"]) for segment in segments), 3),
        "speakerCount": 0,
        "segments": segments,
        "providerUsage": provider_usage,
        "chunks": len(results),
    }


def _extract_chunks(
    source: Path,
    destination: Path,
    settings: Settings,
    chunk_seconds: int,
) -> List[Path]:
    destination.mkdir(parents=True, exist_ok=True)
    pattern = destination / "chunk-%04d.ogg"
    run_command(
        [
            settings.ffmpeg_binary,
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "libopus",
            "-b:a",
            "32k",
            "-f",
            "segment",
            "-segment_time",
            str(chunk_seconds),
            "-reset_timestamps",
            "1",
            str(pattern),
        ],
        timeout=max(300, int(settings.request_timeout_seconds) * 2),
    )
    chunks = sorted(
        path for path in destination.glob("chunk-*.ogg") if path.stat().st_size > 0
    )
    if not chunks:
        raise WorkerError(
            "OPENROUTER_STT_AUDIO_REQUIRED",
            "The source contains no audio stream for OpenRouter transcription",
            status_code=422,
        )
    return chunks


def _chunk_offsets(
    chunks: Sequence[Path], settings: Settings
) -> List[Tuple[Path, float, float]]:
    values: List[Tuple[Path, float, float]] = []
    offset = 0.0
    for chunk in chunks:
        metadata = run_command(
            [
                settings.ffprobe_binary,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                str(chunk),
            ],
            timeout=30,
            capture_json=True,
        )
        try:
            duration = max(0.001, float(metadata["format"]["duration"]))
        except (KeyError, TypeError, ValueError) as error:
            raise WorkerError(
                "OPENROUTER_STT_CHUNK_INVALID",
                "Unable to determine an extracted audio chunk duration",
            ) from error
        values.append((chunk, offset, duration))
        offset += duration
    return values


def _transcribe_chunks(
    chunks: Sequence[Tuple[Path, float, float]],
    models: Sequence[str],
    language: str,
    settings: Settings,
) -> List[Dict[str, Any]]:
    concurrency = max(
        1,
        min(
            len(chunks),
            int(settings.openrouter_stt_concurrency),
        ),
    )
    results: List[Dict[str, Any] | None] = [None] * len(chunks)
    with ThreadPoolExecutor(
        max_workers=concurrency, thread_name_prefix="openrouter-stt"
    ) as executor:
        futures = {
            executor.submit(
                _transcribe_chunk,
                path,
                offset,
                duration,
                models,
                language,
                settings,
            ): index
            for index, (path, offset, duration) in enumerate(chunks)
        }
        for future in as_completed(futures):
            results[futures[future]] = future.result()
    return [value for value in results if value is not None]


def _transcribe_chunk(
    path: Path,
    offset: float,
    duration: float,
    models: Sequence[str],
    language: str,
    settings: Settings,
) -> Dict[str, Any]:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    last_error: WorkerError | None = None
    for model in models:
        payload: Dict[str, Any] = {
            "model": model,
            "input_audio": {"data": encoded, "format": "ogg"},
            "temperature": 0,
            "response_format": "verbose_json",
            "timestamp_granularities": ["segment", "word"],
            "provider": {
                "sort": settings.llm_provider_sort,
                "allow_fallbacks": True,
                "require_parameters": True,
                "data_collection": "deny",
                "zdr": True,
            },
        }
        if language:
            payload["language"] = language
        try:
            started = time.monotonic()
            body, request_id = _request_json(payload, settings)
            elapsed_ms = round((time.monotonic() - started) * 1000)
            return _normalize_chunk(
                body,
                request_id,
                model,
                offset,
                duration,
                language,
                elapsed_ms,
            )
        except WorkerError as error:
            last_error = error
            if error.code != "OPENROUTER_STT_MODEL_UNAVAILABLE":
                raise
            logger.warning("OpenRouter STT model unavailable; trying fallback")
    assert last_error is not None
    raise last_error


def _request_json(
    payload: Mapping[str, Any], settings: Settings
) -> Tuple[Dict[str, Any], str]:
    encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    attempts = max(1, min(3, int(settings.openrouter_stt_retries)))
    for attempt in range(attempts):
        request = urllib.request.Request(
            OPENROUTER_TRANSCRIPTIONS_URL,
            data=encoded,
            headers={
                "authorization": "Bearer %s" % settings.llm_api_key,
                "content-type": "application/json",
                "user-agent": "PicaShorts-Media-Worker/1.0",
                "http-referer": "https://picashorts.com",
                "x-openrouter-title": "PicaShorts STT",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=settings.openrouter_stt_timeout_seconds
            ) as response:
                body = json.loads(response.read().decode("utf-8"))
                request_id = str(response.headers.get("x-generation-id") or "")
            if not isinstance(body, dict):
                raise ValueError("OpenRouter STT response must be an object")
            return body, request_id
        except urllib.error.HTTPError as error:
            status = int(error.code)
            detail = _safe_http_body(error)
            if status in MODEL_UNAVAILABLE_STATUS:
                raise WorkerError(
                    "OPENROUTER_STT_MODEL_UNAVAILABLE",
                    "OpenRouter STT model is unavailable",
                    status_code=503,
                    detail={"status": status, "response": detail},
                ) from error
            if status not in RETRYABLE_STATUS or attempt + 1 >= attempts:
                raise WorkerError(
                    "OPENROUTER_STT_RATE_LIMITED"
                    if status == 429
                    else "OPENROUTER_STT_FAILED",
                    "OpenRouter transcription failed",
                    status_code=503 if status in RETRYABLE_STATUS else 502,
                    detail={"status": status, "response": detail},
                ) from error
            time.sleep(_retry_after(error, attempt))
        except (urllib.error.URLError, TimeoutError) as error:
            # Do not retry an uncertain request: the provider may have accepted and billed it.
            raise WorkerError(
                "OPENROUTER_STT_UNAVAILABLE",
                "OpenRouter transcription is unavailable",
                status_code=503,
                detail={"reason": str(error)[:200]},
            ) from error
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
            raise WorkerError(
                "OPENROUTER_STT_RESPONSE_INVALID",
                "OpenRouter returned an invalid transcription response",
                status_code=502,
            ) from error
    raise AssertionError("OpenRouter STT retry loop exhausted")


def _normalize_chunk(
    body: Mapping[str, Any],
    request_id: str,
    requested_model: str,
    offset: float,
    fallback_duration: float,
    requested_language: str,
    latency_ms: int,
) -> Dict[str, Any]:
    raw_words = body.get("words") if isinstance(body.get("words"), list) else []
    words = [
        _normalize_word(value, offset)
        for value in raw_words
        if isinstance(value, Mapping)
    ]
    words = [value for value in words if value is not None]
    raw_segments = (
        body.get("segments") if isinstance(body.get("segments"), list) else []
    )
    segments: List[Dict[str, Any]] = []
    for raw in raw_segments:
        if not isinstance(raw, Mapping):
            continue
        start = offset + max(0.0, float(raw.get("start") or 0.0))
        end = offset + max(0.0, float(raw.get("end") or 0.0))
        text = str(raw.get("text") or "").strip()
        if end <= start or not text:
            continue
        contained = [
            dict(word)
            for word in words
            if float(word["start"]) >= start - 0.02 and float(word["end"]) <= end + 0.02
        ]
        segments.append(
            {
                "id": len(segments),
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
                "speaker": None,
                "words": contained,
            }
        )
    text = str(body.get("text") or "").strip()
    duration = max(
        0.001,
        float(body.get("duration") or _usage(body).get("seconds") or fallback_duration),
    )
    if not segments and text:
        segments = [
            {
                "id": 0,
                "start": round(offset, 3),
                "end": round(offset + duration, 3),
                "text": text,
                "speaker": None,
                "words": [dict(word) for word in words],
            }
        ]
    if not segments:
        raise WorkerError(
            "TRANSCRIPT_EMPTY", "OpenRouter returned no speech for an audio chunk"
        )
    usage = _usage(body)
    cost_usd = max(0.0, float(usage.get("cost") or 0.0))
    model = str(body.get("model") or requested_model)
    generation_id = str(
        request_id or body.get("id") or _stable_request_id(body, offset)
    )
    return {
        "model": model,
        "language": _response_language(body.get("language"), requested_language),
        "segments": segments,
        "providerUsage": [
            {
                "provider": "openrouter",
                "requestId": generation_id,
                "quantity": round(float(usage.get("seconds") or duration), 3),
                "unit": "second",
                "costUsd": round(cost_usd, 6),
                "latencyMs": latency_ms,
                "model": model,
            }
        ],
    }


def _normalize_word(value: Mapping[str, Any], offset: float) -> Dict[str, Any] | None:
    if value.get("start") is None or value.get("end") is None:
        return None
    start = offset + float(value["start"])
    end = offset + float(value["end"])
    if end <= start:
        return None
    confidence = value.get("confidence")
    return {
        "word": str(value.get("word") or value.get("text") or "").strip(),
        "start": round(start, 3),
        "end": round(end, 3),
        "confidence": None if confidence is None else round(float(confidence), 5),
        "speaker": None,
    }


def _usage(body: Mapping[str, Any]) -> Mapping[str, Any]:
    return body.get("usage") if isinstance(body.get("usage"), Mapping) else {}


def _stable_request_id(body: Mapping[str, Any], offset: float) -> str:
    import hashlib

    value = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return (
        "openrouter-stt-%s"
        % hashlib.sha256(("%s:%s" % (offset, value)).encode("utf-8")).hexdigest()[:24]
    )


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


def _language_code(value: str) -> str:
    return value.strip().replace("_", "-").split("-", 1)[0].lower()


def _response_language(value: Any, requested: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in LANGUAGE_NAMES:
        return LANGUAGE_NAMES[normalized]
    if 2 <= len(normalized) <= 3 and normalized.isalpha():
        return normalized
    return requested or "unknown"


def _majority(values: Sequence[str], fallback: str) -> str:
    normalized = [value for value in values if value and value != "unknown"]
    if not normalized:
        return fallback
    return max(set(normalized), key=lambda value: (normalized.count(value), value))
