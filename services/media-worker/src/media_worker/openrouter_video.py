from __future__ import annotations

import base64
import hashlib
import json
import random
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Mapping, Optional

from .process import run_command


OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_VIDEO_MODEL = "google/gemini-3.1-flash-lite"
MAX_PROXY_BYTES = 20 * 1024 * 1024
RETRYABLE_HTTP_CODES = {408, 409, 425, 429, 500, 502, 503, 504}


class OpenRouterVideoError(RuntimeError):
    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.retryable = retryable


def enabled(settings: Any) -> bool:
    return (
        bool(getattr(settings, "openrouter_video_enabled", True))
        and str(getattr(settings, "llm_provider", "none")).lower() == "openrouter"
        and bool(str(getattr(settings, "llm_api_key", "") or ""))
    )


def create_proxy(
    source: Path,
    destination_dir: Path,
    settings: Any,
    *,
    clip_id: str,
    start_seconds: Optional[float] = None,
    end_seconds: Optional[float] = None,
) -> Optional[Path]:
    """Create an audio-bearing proxy small enough for OpenRouter video input.

    When `start_seconds`/`end_seconds` are provided, trims the source to that
    range first -- used to proxy a time slice of the raw source clip (e.g. for
    proactive speaker analysis) rather than the whole file. Existing call sites
    that omit them keep proxying the file as-is.
    """
    destination_dir.mkdir(parents=True, exist_ok=True)
    safe_id = "".join(value if value.isalnum() or value in {"-", "_"} else "-" for value in clip_id)
    trim_args: list[str] = []
    if start_seconds is not None:
        trim_args.extend(["-ss", str(max(0.0, float(start_seconds)))])
    if end_seconds is not None:
        trim_args.extend(["-to", str(max(0.0, float(end_seconds)))])
    attempts = (
        (480, 12, 30, 80),
        (360, 8, 34, 56),
    )
    for height, fps, crf, audio_kbps in attempts:
        destination = destination_dir / ("%s-%dp-%dfps.mp4" % (safe_id, height, fps))
        run_command(
            [
                str(getattr(settings, "ffmpeg_binary", "ffmpeg")),
                "-y",
                *trim_args,
                "-i",
                str(source),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0?",
                "-vf",
                (
                    "scale=-2:'min(%d,ih)':flags=lanczos,"
                    "fps=%d,setpts=PTS-STARTPTS"
                )
                % (height, fps),
                "-af",
                "aresample=async=1:first_pts=0",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                str(crf),
                "-c:a",
                "aac",
                "-b:a",
                "%dk" % audio_kbps,
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-shortest",
                str(destination),
            ],
            timeout=300,
        )
        if destination.is_file() and 0 < destination.stat().st_size <= max_proxy_bytes(settings):
            return destination
        destination.unlink(missing_ok=True)
    return None


def analyze_video(
    video: Path,
    prompt: Mapping[str, Any],
    settings: Any,
    *,
    max_tokens: int = 1200,
) -> Dict[str, Any]:
    maximum = max_proxy_bytes(settings)
    size = video.stat().st_size
    if size <= 0 or size > maximum:
        raise OpenRouterVideoError(
            "Video proxy is outside the configured upload limit (%d bytes)" % maximum
        )
    encoded = base64.b64encode(video.read_bytes()).decode("ascii")
    payload = {
        "model": video_model(settings),
        "provider": {
            "sort": getattr(settings, "llm_provider_sort", "latency"),
            "require_parameters": True,
            "data_collection": "deny",
            "zdr": True,
        },
        "temperature": 0,
        "max_tokens": max(256, min(4000, int(max_tokens))),
        "usage": {"include": True},
        "response_format": {"type": "json_object"},
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(prompt, ensure_ascii=False, separators=(",", ":")),
                    },
                    {
                        "type": "video_url",
                        "video_url": {
                            "url": "data:video/mp4;base64,%s" % encoded,
                        },
                    },
                ],
            }
        ],
    }
    started = time.monotonic()
    body = _request_json(payload, settings)
    content = _message_text(body)
    usage = body.get("usage") if isinstance(body.get("usage"), Mapping) else {}
    return {
        "content": content,
        "usage": {
            "provider": "openrouter",
            "requestId": str(body.get("id") or _response_id(body)),
            "quantity": int(usage.get("total_tokens") or 0),
            "unit": "token",
            "costUsd": round(_cost(usage), 6),
            "latencyMs": round((time.monotonic() - started) * 1000),
            "model": payload["model"],
        },
    }


def _message_text(body: Mapping[str, Any]) -> str:
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise OpenRouterVideoError(
            "OpenRouter returned no video analysis", retryable=True
        ) from error
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        text = "".join(
            str(block.get("text") or "")
            for block in content
            if isinstance(block, Mapping)
            and str(block.get("type") or "") in {"text", "output_text"}
        ).strip()
        if text:
            return text
    raise OpenRouterVideoError(
        "OpenRouter video analysis content must contain text", retryable=True
    )


def _request_json(payload: Mapping[str, Any], settings: Any) -> Dict[str, Any]:
    request = urllib.request.Request(
        OPENROUTER_CHAT_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "authorization": "Bearer %s" % str(getattr(settings, "llm_api_key", "")),
            "content-type": "application/json",
            "http-referer": "https://picashorts.com",
            "x-openrouter-title": "PicaShorts Video Editor",
        },
        method="POST",
    )
    attempts = max(1, min(5, int(getattr(settings, "openrouter_video_retries", 3))))
    timeout = max(10, int(getattr(settings, "openrouter_video_timeout_seconds", 90)))
    last_error: Optional[BaseException] = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, dict):
                raise OpenRouterVideoError("OpenRouter response must be an object")
            return value
        except urllib.error.HTTPError as error:
            last_error = error
            retryable = error.code in RETRYABLE_HTTP_CODES
            try:
                error.close()
            except AttributeError:
                pass
            if not retryable or attempt + 1 >= attempts:
                raise OpenRouterVideoError(
                    "OpenRouter video request failed with HTTP %d" % error.code,
                    retryable=retryable,
                ) from error
            time.sleep(_retry_delay(error, attempt))
        except (TimeoutError, urllib.error.URLError) as error:
            last_error = error
            if attempt + 1 >= attempts:
                raise OpenRouterVideoError(
                    "OpenRouter video request is unavailable", retryable=True
                ) from error
            time.sleep(_retry_delay(None, attempt))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise OpenRouterVideoError("OpenRouter returned invalid JSON") from error
    raise OpenRouterVideoError("OpenRouter video request failed") from last_error


def video_model(settings: Any) -> str:
    return (
        str(
            getattr(settings, "openrouter_video_model", "")
            or getattr(settings, "openrouter_editor_model", "")
            or DEFAULT_VIDEO_MODEL
        ).strip()
        or DEFAULT_VIDEO_MODEL
    )


def max_proxy_bytes(settings: Any) -> int:
    configured = int(getattr(settings, "openrouter_video_max_bytes", MAX_PROXY_BYTES))
    return max(1024 * 1024, min(50 * 1024 * 1024, configured))


def _retry_delay(error: Optional[urllib.error.HTTPError], attempt: int) -> float:
    if error is not None:
        try:
            return max(0.0, min(10.0, float(error.headers.get("retry-after") or 0.0)))
        except (TypeError, ValueError):
            pass
    return min(8.0, (2**attempt) + random.random() * 0.25)


def _cost(usage: Mapping[str, Any]) -> float:
    for key in ("cost", "total_cost", "totalCost"):
        try:
            if key in usage:
                return max(0.0, float(usage.get(key) or 0.0))
        except (TypeError, ValueError):
            continue
    return 0.0


def _response_id(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")
    return "openrouter-video-%s" % hashlib.sha256(encoded).hexdigest()[:24]
