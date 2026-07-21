import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Mapping, Optional

from .config import Settings
from .errors import WorkerError
from .workspace import Workspace


TERMINAL_FAILURES = {"FAILED", "CANCELLED", "TIMED_OUT"}
_CAPACITY_LOCK = threading.Lock()
_CAPACITIES: Dict[int, threading.BoundedSemaphore] = {}


def execute_remote_job(
    workspace: Workspace,
    stage: str,
    payload: Mapping[str, Any],
    settings: Settings,
) -> Dict[str, Any]:
    if settings.gpu_provider != "runpod":
        raise WorkerError("RUNPOD_DISABLED", "Runpod GPU execution is not enabled")
    idempotency_key = str(payload.get("idempotencyKey") or "").strip()
    if not idempotency_key:
        raise WorkerError("RUNPOD_IDEMPOTENCY_REQUIRED", "Remote GPU jobs require an idempotency key")
    capacity = _capacity(settings.remote_max_concurrency)
    if not capacity.acquire(timeout=1):
        raise WorkerError(
            "RUNPOD_CONCURRENCY_LIMIT",
            "Runpod concurrency is saturated; local fallback will continue",
            status_code=503,
        )
    try:
        return _execute_remote_job(workspace, stage, payload, settings, idempotency_key)
    finally:
        capacity.release()


def _execute_remote_job(
    workspace: Workspace,
    stage: str,
    payload: Mapping[str, Any],
    settings: Settings,
    idempotency_key: str,
) -> Dict[str, Any]:
    state_path = "remote/runpod-%s.json" % stage
    state = _load_state(workspace, state_path)
    job_id = str(state.get("jobId") or "") if state.get("idempotencyKey") == idempotency_key else ""
    if (
        not job_id
        and state.get("idempotencyKey") == idempotency_key
        and state.get("status") == "SUBMITTING"
    ):
        raise WorkerError(
            "RUNPOD_SUBMISSION_UNCERTAIN",
            "Runpod submission outcome is uncertain; local fallback prevents duplicate billing",
            status_code=503,
        )
    if not job_id or state.get("status") in TERMINAL_FAILURES:
        workspace.write_json(
            state_path,
            {"idempotencyKey": idempotency_key, "status": "SUBMITTING"},
        )
        job_id = _submit(payload, settings)
        workspace.write_json(
            state_path,
            {"jobId": job_id, "idempotencyKey": idempotency_key, "status": "IN_QUEUE"},
        )
    started = time.monotonic()
    deadline = started + settings.runpod_timeout_seconds
    while time.monotonic() < deadline:
        status = _status(job_id, settings)
        state_name = str(status.get("status") or "").upper()
        workspace.write_json(
            state_path,
            {"jobId": job_id, "idempotencyKey": idempotency_key, "status": state_name},
        )
        if state_name == "COMPLETED":
            output = status.get("output")
            if not isinstance(output, Mapping):
                raise WorkerError(
                    "RUNPOD_RESPONSE_INVALID",
                    "Runpod completed without a valid output payload",
                    status_code=502,
                )
            value = dict(output)
            metrics = value.get("metrics") if isinstance(value.get("metrics"), Mapping) else {}
            if metrics.get("gpuSeconds") is not None:
                gpu_seconds = float(metrics.get("gpuSeconds") or 0.0)
            else:
                # Runpod queue endpoint executionTime is always reported in milliseconds.
                gpu_seconds = float(status.get("executionTime") or 0.0) / 1000.0
            cost_usd = float(metrics.get("costUsd") or gpu_seconds * settings.runpod_cost_usd_per_second)
            provider_usage = value.get("providerUsage")
            provider_usage = list(provider_usage) if isinstance(provider_usage, list) else []
            provider_usage.append(
                {
                    "provider": "runpod",
                    "requestId": job_id,
                    "quantity": round(gpu_seconds, 3),
                    "unit": "gpu-second",
                    "costUsd": round(cost_usd, 6),
                    "latencyMs": round((time.monotonic() - started) * 1000),
                    "model": str(metrics.get("model") or "media-worker-gpu-serverless"),
                }
            )
            value["providerUsage"] = provider_usage
            return value
        if state_name in TERMINAL_FAILURES:
            error = status.get("error")
            raise WorkerError(
                "RUNPOD_JOB_%s" % state_name,
                "Runpod GPU job did not complete",
                status_code=503,
                detail={
                    "jobId": job_id,
                    "reason": str(error)[:300],
                    "providerUsage": [_provider_usage(job_id, status, started, settings)],
                },
            )
        time.sleep(settings.runpod_poll_seconds)
    raise WorkerError(
        "RUNPOD_TIMEOUT",
        "Runpod GPU job exceeded the configured timeout",
        status_code=504,
        detail={"jobId": job_id},
    )


def _capacity(limit: int) -> threading.BoundedSemaphore:
    value = max(1, min(8, int(limit)))
    with _CAPACITY_LOCK:
        if value not in _CAPACITIES:
            _CAPACITIES[value] = threading.BoundedSemaphore(value)
        return _CAPACITIES[value]


def _provider_usage(
    job_id: str, status: Mapping[str, Any], started: float, settings: Settings
) -> Dict[str, Any]:
    gpu_seconds = float(status.get("executionTime") or 0.0) / 1000.0
    return {
        "provider": "runpod",
        "requestId": job_id,
        "quantity": round(gpu_seconds, 3),
        "unit": "gpu-second",
        "costUsd": round(gpu_seconds * settings.runpod_cost_usd_per_second, 6),
        "latencyMs": round((time.monotonic() - started) * 1000),
        "model": "media-worker-gpu-serverless",
    }


def _submit(payload: Mapping[str, Any], settings: Settings) -> str:
    response = _request_json(
        "%s/run" % _base_url(settings),
        settings,
        method="POST",
        body={
            "input": dict(payload),
            "policy": {
                "executionTimeout": settings.runpod_timeout_seconds * 1000,
                "ttl": min(7_200_000, (settings.runpod_timeout_seconds + 1800) * 1000),
            },
        },
    )
    job_id = str(response.get("id") or "")
    if not job_id:
        raise WorkerError("RUNPOD_RESPONSE_INVALID", "Runpod did not return a job ID", status_code=502)
    return job_id


def _status(job_id: str, settings: Settings) -> Dict[str, Any]:
    return _request_json("%s/status/%s" % (_base_url(settings), job_id), settings)


def _base_url(settings: Settings) -> str:
    return "https://api.runpod.ai/v2/%s" % settings.runpod_endpoint_id


def _request_json(
    url: str,
    settings: Settings,
    *,
    method: str = "GET",
    body: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "authorization": "Bearer %s" % settings.runpod_api_key,
            "content-type": "application/json",
            "user-agent": "PicaShorts-Media-Worker/1.0",
        },
        method=method,
    )
    last_error: BaseException | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                value = json.loads(response.read().decode("utf-8"))
            if not isinstance(value, dict):
                raise ValueError("response must be an object")
            return value
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in {408, 425, 429, 500, 502, 503, 504} or attempt == 2:
                raise WorkerError(
                    "RUNPOD_RATE_LIMITED" if error.code == 429 else "RUNPOD_REQUEST_FAILED",
                    "Runpod request failed",
                    status_code=503,
                    detail={"status": error.code},
                ) from error
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            last_error = error
            if attempt == 2:
                break
        time.sleep(float(2**attempt))
    raise WorkerError(
        "RUNPOD_UNAVAILABLE",
        "Runpod is unavailable",
        status_code=503,
        detail={"reason": str(last_error)[:200] if last_error else "unknown"},
    ) from last_error


def _load_state(workspace: Workspace, path: str) -> Dict[str, Any]:
    value = workspace.path(path)
    if not value.is_file():
        return {}
    try:
        state = workspace.read_json(path)
        return state if isinstance(state, dict) else {}
    except (OSError, ValueError, json.JSONDecodeError):
        return {}
