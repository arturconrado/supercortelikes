from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Iterator

try:
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
except Exception:  # pragma: no cover - fallback for dev environments before deps are installed.
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"

    class _NoopMetric:
        def labels(self, **_labels):
            return self

        def inc(self, _amount: float = 1.0) -> None:
            return None

        def dec(self, _amount: float = 1.0) -> None:
            return None

        def observe(self, _value: float) -> None:
            return None

        def set(self, _value: float) -> None:
            return None

    Counter = Gauge = Histogram = lambda *_args, **_kwargs: _NoopMetric()  # type: ignore

    def generate_latest() -> bytes:  # type: ignore
        return b"# HELP media_worker_prometheus_client_available prometheus_client import status\n# TYPE media_worker_prometheus_client_available gauge\nmedia_worker_prometheus_client_available 0\n"


stage_requests = Counter(
    "media_worker_stage_requests_total",
    "Media-worker stage requests by stage and result",
    ["stage", "result"],
)
stage_duration = Histogram(
    "media_worker_stage_duration_seconds",
    "Media-worker stage execution duration",
    ["stage", "result"],
    buckets=(0.1, 0.5, 1, 2.5, 5, 15, 30, 60, 120, 300, 600, 1200, 3600),
)
capacity_active = Gauge(
    "media_worker_capacity_active",
    "Active media-worker jobs by capacity class",
    ["kind"],
)
worker_errors = Counter(
    "media_worker_errors_total",
    "Media-worker errors by stage and code",
    ["stage", "code"],
)


@contextmanager
def observe_stage(stage: str, kind: str) -> Iterator[None]:
    started_at = time.perf_counter()
    result = "succeeded"
    capacity_active.labels(kind=kind).inc()
    try:
        yield
    except Exception as error:
        result = "failed"
        code = getattr(error, "code", type(error).__name__)
        worker_errors.labels(stage=stage, code=str(code)).inc()
        raise
    finally:
        capacity_active.labels(kind=kind).dec()
        stage_requests.labels(stage=stage, result=result).inc()
        stage_duration.labels(stage=stage, result=result).observe(time.perf_counter() - started_at)


def metrics_payload() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
