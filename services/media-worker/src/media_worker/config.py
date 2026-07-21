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
    llm_provider_sort: str
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
    media_accelerator: str
    ai_execution_mode: str
    stt_provider: str
    deepgram_api_key: str
    deepgram_model: str
    deepgram_language: str
    deepgram_timeout_seconds: int
    deepgram_cost_usd_per_hour: float
    openrouter_editor_model: str
    openrouter_qa_enabled: bool
    gpu_provider: str
    runpod_api_key: str
    runpod_endpoint_id: str
    runpod_timeout_seconds: int
    runpod_poll_seconds: float
    runpod_cost_usd_per_second: float
    ai_cost_limit_usd_per_source_hour: float
    remote_max_concurrency: int
    auto_render_mode: str
    final_max_short_side: int

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
            whisper_model=os.getenv("WHISPERX_MODEL", "small"),
            whisper_device=os.getenv("WHISPERX_DEVICE", "cpu"),
            whisper_compute_type=os.getenv("WHISPERX_COMPUTE_TYPE", "int8"),
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
            llm_model=os.getenv("LLM_MODEL", "google/gemini-2.5-flash-lite"),
            llm_timeout_seconds=max(5, int(os.getenv("LLM_TIMEOUT_SECONDS", "45"))),
            llm_provider_sort=os.getenv("LLM_PROVIDER_SORT", "latency").strip().lower(),
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
            ffmpeg_crf=max(16, min(35, int(os.getenv("FFMPEG_CRF", "19")))),
            ffmpeg_threads=max(1, min(32, int(os.getenv("FFMPEG_THREADS", "2")))),
            ffmpeg_filter_threads=max(1, min(16, int(os.getenv("FFMPEG_FILTER_THREADS", "1")))),
            render_max_height=max(360, min(2160, int(os.getenv("RENDER_MAX_HEIGHT", "720")))),
            render_max_source_short_side=max(
                360, min(2160, int(os.getenv("RENDER_MAX_SOURCE_SHORT_SIDE", "1080")))
            ),
            allow_full_batch_render=_bool_env("ALLOW_FULL_BATCH_RENDER", False),
            metrics_enabled=_bool_env("MEDIA_WORKER_METRICS_ENABLED", True),
            ytdlp_fragment_concurrency=max(1, min(16, int(os.getenv("YTDLP_FRAGMENT_CONCURRENCY", "4")))),
            log_level=os.getenv("LOG_LEVEL", "info").lower(),
            media_accelerator=os.getenv("MEDIA_ACCELERATOR", "cpu").strip().lower(),
            ai_execution_mode=os.getenv("AI_EXECUTION_MODE", "local").strip().lower(),
            stt_provider=os.getenv("STT_PROVIDER", "whisperx").strip().lower(),
            deepgram_api_key=os.getenv("DEEPGRAM_API_KEY", "").strip(),
            deepgram_model=os.getenv("DEEPGRAM_MODEL", "nova-3").strip() or "nova-3",
            deepgram_language=os.getenv("DEEPGRAM_LANGUAGE", "pt-BR").strip() or "pt-BR",
            deepgram_timeout_seconds=max(30, min(7200, int(os.getenv("DEEPGRAM_TIMEOUT_SECONDS", "1800")))),
            deepgram_cost_usd_per_hour=max(0.0, float(os.getenv("DEEPGRAM_COST_USD_PER_HOUR", "0.35"))),
            openrouter_editor_model=os.getenv(
                "OPENROUTER_EDITOR_MODEL",
                os.getenv("LLM_MODEL", "google/gemini-2.5-flash"),
            ).strip() or "google/gemini-2.5-flash",
            openrouter_qa_enabled=_bool_env("OPENROUTER_QA_ENABLED", True),
            gpu_provider=os.getenv("GPU_PROVIDER", "none").strip().lower(),
            runpod_api_key=os.getenv("RUNPOD_API_KEY", "").strip(),
            runpod_endpoint_id=os.getenv("RUNPOD_ENDPOINT_ID", "").strip(),
            runpod_timeout_seconds=max(60, min(7200, int(os.getenv("RUNPOD_TIMEOUT_SECONDS", "3600")))),
            runpod_poll_seconds=max(0.5, min(30.0, float(os.getenv("RUNPOD_POLL_SECONDS", "2")))),
            runpod_cost_usd_per_second=max(
                0.0, float(os.getenv("RUNPOD_COST_USD_PER_SECOND", "0.00019"))
            ),
            ai_cost_limit_usd_per_source_hour=max(
                0.0, float(os.getenv("AI_COST_LIMIT_USD_PER_SOURCE_HOUR", "1.00"))
            ),
            remote_max_concurrency=max(1, min(8, int(os.getenv("REMOTE_MAX_CONCURRENCY", "2")))),
            auto_render_mode=os.getenv("AUTO_RENDER_MODE", "all").strip().lower(),
            final_max_short_side=max(
                360, min(1080, int(os.getenv("FINAL_MAX_SHORT_SIDE", "1080")))
            ),
        )
        settings.validate()
        return settings

    def validate(self) -> None:
        if self.media_accelerator not in {"cpu", "cuda"}:
            raise RuntimeError("MEDIA_ACCELERATOR must be cpu or cuda")
        if self.media_accelerator == "cuda" and self.whisper_device != "cuda":
            raise RuntimeError("MEDIA_ACCELERATOR=cuda requires WHISPERX_DEVICE=cuda")
        if self.llm_provider_sort not in {"price", "throughput", "latency"}:
            raise RuntimeError("LLM_PROVIDER_SORT must be price, throughput or latency")
        if self.ai_execution_mode not in {"local", "hybrid"}:
            raise RuntimeError("AI_EXECUTION_MODE must be local or hybrid")
        if self.stt_provider not in {"whisperx", "deepgram"}:
            raise RuntimeError("STT_PROVIDER must be whisperx or deepgram")
        if self.gpu_provider not in {"none", "runpod"}:
            raise RuntimeError("GPU_PROVIDER must be none or runpod")
        if self.auto_render_mode not in {"off", "all"}:
            raise RuntimeError("AUTO_RENDER_MODE must be off or all")
        if self.ai_execution_mode == "hybrid":
            if self.stt_provider == "deepgram" and not self.deepgram_api_key:
                raise RuntimeError("DEEPGRAM_API_KEY is required for hybrid Deepgram transcription")
            if self.gpu_provider == "runpod" and (not self.runpod_api_key or not self.runpod_endpoint_id):
                raise RuntimeError("RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID are required for Runpod")
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
