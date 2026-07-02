import hmac
import logging
import os
import shutil
import threading
from functools import lru_cache
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, Header, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import __version__
from .config import Settings
from .errors import WorkerError
from .logging_config import configure_logging
from .memory import release_runtime_memory
from .models import PipelineRequest, ReframeRequest, SeoRequest
from .pipeline import Pipeline, STAGES
from .seo import generate_seo


settings = Settings.from_env()
configure_logging(settings.log_level)
logger = logging.getLogger(__name__)
pipeline = Pipeline(settings)
stage_capacity = threading.BoundedSemaphore(settings.max_concurrent_jobs)
app = FastAPI(
    title="PicaShorts Media Worker",
    version=__version__,
    docs_url=None,
    redoc_url=None,
)


@app.exception_handler(WorkerError)
async def worker_error_handler(_: Request, error: WorkerError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={
            "error": {"code": error.code, "message": str(error), "detail": error.detail}
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, error: Exception) -> JSONResponse:
    logger.exception("Unhandled media-worker error")
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "MEDIA_WORKER_INTERNAL_ERROR",
                "message": "Media worker failed while executing the requested operation",
                "detail": {"type": type(error).__name__},
            }
        },
    )


def authorize(authorization: Optional[str] = Header(None)) -> None:
    if not settings.internal_token:
        return
    expected = "Bearer %s" % settings.internal_token
    if authorization is None or not hmac.compare_digest(authorization, expected):
        raise WorkerError(
            "UNAUTHORIZED", "A valid internal bearer token is required", status_code=401
        )


@app.get("/health/live")
async def liveness() -> Dict[str, Any]:
    return {"status": "ok", "service": "media-worker", "version": __version__}


@app.get("/health/ready")
async def readiness() -> JSONResponse:
    dependencies = await run_in_threadpool(_readiness_dependencies)
    required = ["ffmpeg", "ffprobe", "storage", "workspace"]
    if settings.redis_url:
        required.append("redis")
    if settings.enable_ai:
        required.append("modelCache")
    if settings.enable_whisperx:
        required.append("whisperx")
    if settings.enable_opencv:
        required.append("opencv")
    if settings.enable_mediapipe:
        required.append("mediapipe")
    if settings.enable_yolo:
        required.append("yolo")
    if settings.diarization_enabled:
        required.append("huggingFaceToken")
    required_ready = all(bool(dependencies[name]) for name in required)
    return JSONResponse(
        status_code=200 if required_ready else 503,
        content={
            "status": "ready" if required_ready else "not-ready",
            "required": required,
            "dependencies": dependencies,
        },
    )


def _readiness_dependencies() -> Dict[str, bool]:
    imports = _ai_imports()
    return {
        "ffmpeg": shutil.which(settings.ffmpeg_binary) is not None,
        "ffprobe": shutil.which(settings.ffprobe_binary) is not None,
        **imports,
        "workspace": _path_writable(settings.data_dir),
        "modelCache": _model_cache_ready(),
        "storage": _storage_ready(),
        "redis": _redis_ready(),
        "huggingFaceToken": bool(settings.hf_token),
    }


def _path_writable(path: Any) -> bool:
    try:
        directory = path if hasattr(path, "mkdir") else settings.data_dir / str(path)
        directory.mkdir(parents=True, exist_ok=True)
        probe = directory / ".picashorts-write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except BaseException:
        return False


def _model_cache_ready() -> bool:
    paths = [
        os.getenv("HF_HOME"),
        os.getenv("TORCH_HOME"),
        os.getenv("XDG_CACHE_HOME"),
        os.getenv("MPLCONFIGDIR"),
        os.getenv("YOLO_CONFIG_DIR"),
    ]
    return all(_path_writable(value) for value in paths if value)


@lru_cache(maxsize=1)
def _ai_imports() -> Dict[str, bool]:
    status: Dict[str, bool] = {}
    for public_name, module_name in (
        ("whisperx", "whisperx"),
        ("opencv", "cv2"),
        ("mediapipe", "mediapipe"),
        ("yolo", "ultralytics"),
    ):
        try:
            __import__(module_name)
            status[public_name] = True
        except BaseException:
            status[public_name] = False
    return status


def _storage_ready() -> bool:
    if not all(
        (
            settings.s3_endpoint_url,
            settings.s3_access_key_id,
            settings.s3_secret_access_key,
            settings.s3_bucket,
        )
    ):
        return False
    try:
        import boto3
        from botocore.config import Config

        client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            config=Config(
                connect_timeout=2,
                read_timeout=2,
                retries={"max_attempts": 1},
                s3={
                    "addressing_style": "path"
                    if settings.s3_force_path_style
                    else "auto"
                },
            ),
        )
        client.head_bucket(Bucket=settings.s3_bucket)
        return True
    except BaseException:
        return False


def _redis_ready() -> bool:
    if not settings.redis_url:
        return False
    try:
        import redis

        client = redis.Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)
        return bool(client.ping())
    except BaseException:
        return False


def _run_stage(stage: str, body: PipelineRequest):
    with stage_capacity:
        try:
            result = pipeline.execute(stage, body)
            if stage == "exports" and not settings.retain_downloads:
                shutil.rmtree(
                    settings.data_dir / body.pipeline_run_id, ignore_errors=True
                )
            return result
        finally:
            release_runtime_memory()


def _run_reframe(body: ReframeRequest):
    with stage_capacity:
        try:
            return pipeline.reframe(body)
        finally:
            release_runtime_memory()


@app.post("/v1/stages/{stage}", dependencies=[Depends(authorize)])
async def execute_stage(stage: str, body: PipelineRequest) -> Dict[str, Any]:
    if stage not in STAGES:
        raise WorkerError(
            "UNKNOWN_STAGE", "Unsupported pipeline stage: %s" % stage, status_code=404
        )
    result = await run_in_threadpool(_run_stage, stage, body)
    return result.model_dump(mode="json", by_alias=True)


@app.post("/v1/reframe", dependencies=[Depends(authorize)])
async def execute_reframe(body: ReframeRequest) -> Dict[str, Any]:
    result = await run_in_threadpool(_run_reframe, body)
    return result.model_dump(mode="json", by_alias=True)


@app.post("/v1/seo", dependencies=[Depends(authorize)])
async def execute_seo(body: SeoRequest) -> Dict[str, Any]:
    return await run_in_threadpool(
        generate_seo, body.transcript, body.subject, body.audience
    )
