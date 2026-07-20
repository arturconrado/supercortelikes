import os
from dataclasses import dataclass
from pathlib import Path


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    ffmpeg_binary: str
    ffprobe_binary: str
    max_download_bytes: int
    request_timeout_seconds: int
    whisper_model: str
    whisper_device: str
    whisper_compute_type: str
    hf_token: str
    yolo_model: str
    internal_token: str
    retain_downloads: bool
    s3_endpoint_url: str
    s3_region: str
    s3_access_key_id: str
    s3_secret_access_key: str
    s3_force_path_style: bool
    s3_bucket: str
    ai_required: bool
    diarization_enabled: bool
    app_env: str
    redis_url: str
    enable_ai: bool
    enable_whisperx: bool
    enable_opencv: bool
    enable_mediapipe: bool
    enable_yolo: bool
    llm_provider: str
    llm_api_key: str
    llm_model: str
    llm_timeout_seconds: int
    ytdlp_cookies_file: str
    ytdlp_proxy: str
    ytdlp_user_agent: str
    max_concurrent_jobs: int
    heavy_concurrent_jobs: int
    light_concurrent_jobs: int
    ffmpeg_preset: str
    ffmpeg_crf: int
    ffmpeg_threads: int
    ffmpeg_filter_threads: int
    render_max_height: int
    render_max_source_short_side: int
    allow_full_batch_render: bool
    metrics_enabled: bool
    ytdlp_fragment_concurrency: int
    log_level: str

    @classmethod
    def from_env(cls) -> "Settings":
        ai_required = _bool_env("AI_REQUIRED", False)
        enable_ai = _bool_env("ENABLE_AI", ai_required)
        legacy_concurrency = max(1, int(os.getenv("MEDIA_MAX_CONCURRENT_JOBS", "1")))
        settings = cls(
            data_dir=Path(os.getenv("MEDIA_WORKER_DATA_DIR", "/data"))
            .expanduser()
            .resolve(),
            ffmpeg_binary=os.getenv("FFMPEG_BINARY", "ffmpeg"),
            ffprobe_binary=os.getenv("FFPROBE_BINARY", "ffprobe"),
            max_download_bytes=int(os.getenv("MAX_SOURCE_BYTES", str(6 * 1024**3))),
            request_timeout_seconds=int(os.getenv("SOURCE_TIMEOUT_SECONDS", "120")),
            whisper_model=os.getenv("WHISPERX_MODEL", "large-v3"),
            whisper_device=os.getenv("WHISPERX_DEVICE", "cuda"),
            whisper_compute_type=os.getenv("WHISPERX_COMPUTE_TYPE", "float16"),
            hf_token=os.getenv("HF_TOKEN", ""),
            yolo_model=os.getenv("YOLO_MODEL", "yolo11n.pt"),
            internal_token=os.getenv(
                "MEDIA_WORKER_INTERNAL_TOKEN",
                os.getenv("MEDIA_WORKER_TOKEN", ""),
            ),
            retain_downloads=_bool_env("RETAIN_SOURCE_DOWNLOADS", True),
            s3_endpoint_url=os.getenv(
                "S3_ENDPOINT_URL",
                os.getenv("S3_ENDPOINT", os.getenv("R2_ENDPOINT", "")),
            ),
            s3_region=os.getenv("S3_REGION", os.getenv("R2_REGION", "auto")),
            s3_access_key_id=os.getenv(
                "S3_ACCESS_KEY_ID",
                os.getenv("S3_ACCESS_KEY", os.getenv("R2_ACCESS_KEY_ID", "")),
            ),
            s3_secret_access_key=os.getenv(
                "S3_SECRET_ACCESS_KEY",
                os.getenv("S3_SECRET_KEY", os.getenv("R2_SECRET_ACCESS_KEY", "")),
            ),
            s3_force_path_style=_bool_env("S3_FORCE_PATH_STYLE", False),
            s3_bucket=os.getenv("S3_BUCKET", ""),
            ai_required=ai_required,
            diarization_enabled=_bool_env("MEDIA_DIARIZATION_ENABLED", True),
            app_env=os.getenv("APP_ENV", "local"),
            redis_url=os.getenv("REDIS_URL", ""),
            enable_ai=enable_ai,
            enable_whisperx=_bool_env("ENABLE_WHISPERX", ai_required or enable_ai),
            enable_opencv=_bool_env("ENABLE_OPENCV", ai_required or enable_ai),
            enable_mediapipe=_bool_env("ENABLE_MEDIAPIPE", ai_required or enable_ai),
            enable_yolo=_bool_env("ENABLE_YOLO", ai_required or enable_ai),
            llm_provider=os.getenv("LLM_PROVIDER", "none").strip().lower(),
            llm_api_key=os.getenv("LLM_API_KEY", ""),
            llm_model=os.getenv("LLM_MODEL", "openai/gpt-4o-mini"),
            llm_timeout_seconds=max(5, int(os.getenv("LLM_TIMEOUT_SECONDS", "45"))),
            ytdlp_cookies_file=os.getenv("YTDLP_COOKIES_FILE", "").strip(),
            ytdlp_proxy=os.getenv("YTDLP_PROXY", "").strip(),
            ytdlp_user_agent=os.getenv("YTDLP_USER_AGENT", "").strip(),
            max_concurrent_jobs=legacy_concurrency,
            heavy_concurrent_jobs=max(
                1, int(os.getenv("MEDIA_HEAVY_CONCURRENT_JOBS", str(legacy_concurrency)))
            ),
            light_concurrent_jobs=max(
                1,
                int(
                    os.getenv(
                        "MEDIA_LIGHT_CONCURRENT_JOBS",
                        str(max(legacy_concurrency, 4 if legacy_concurrency == 1 else legacy_concurrency)),
                    )
                ),
            ),
            ffmpeg_preset=os.getenv("FFMPEG_PRESET", "veryfast").strip() or "veryfast",
            ffmpeg_crf=max(16, min(35, int(os.getenv("FFMPEG_CRF", "22")))),
            ffmpeg_threads=max(1, min(32, int(os.getenv("FFMPEG_THREADS", "2")))),
            ffmpeg_filter_threads=max(1, min(16, int(os.getenv("FFMPEG_FILTER_THREADS", "1")))),
            render_max_height=max(360, min(2160, int(os.getenv("RENDER_MAX_HEIGHT", "720")))),
            render_max_source_short_side=max(
                360, min(2160, int(os.getenv("RENDER_MAX_SOURCE_SHORT_SIDE", "2160")))
            ),
            allow_full_batch_render=_bool_env("ALLOW_FULL_BATCH_RENDER", False),
            metrics_enabled=_bool_env("MEDIA_WORKER_METRICS_ENABLED", True),
            ytdlp_fragment_concurrency=max(1, min(16, int(os.getenv("YTDLP_FRAGMENT_CONCURRENCY", "4")))),
            log_level=os.getenv("LOG_LEVEL", "info").lower(),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.app_env not in {"release", "production"}:
            return
        missing = []
        for name, value in (
            ("REDIS_URL", self.redis_url),
            ("S3_ENDPOINT", self.s3_endpoint_url),
            ("S3_ACCESS_KEY_ID", self.s3_access_key_id),
            ("S3_SECRET_ACCESS_KEY", self.s3_secret_access_key),
            ("S3_BUCKET", self.s3_bucket),
            ("MEDIA_WORKER_INTERNAL_TOKEN", self.internal_token),
        ):
            if not value:
                missing.append(name)
        if not self.enable_ai or not self.enable_whisperx:
            missing.append("ENABLE_AI/ENABLE_WHISPERX")
        if self.llm_provider not in {"none", "openrouter"}:
            missing.append("LLM_PROVIDER=openrouter|none")
        if self.llm_provider != "none" and not self.llm_api_key:
            missing.append("LLM_API_KEY")
        if self.diarization_enabled and not self.hf_token:
            missing.append("HF_TOKEN")
        if self.ytdlp_cookies_file and not Path(self.ytdlp_cookies_file).expanduser().is_file():
            missing.append("YTDLP_COOKIES_FILE")
        if missing:
            raise RuntimeError("Missing required worker configuration: %s" % ", ".join(missing))
