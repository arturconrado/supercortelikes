import subprocess
import sys
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from media_worker.config import Settings
from media_worker.errors import DependencyUnavailable, WorkerError
from media_worker.process import require_binary, run_command
from media_worker.rendering import render_clips
from media_worker.storage import upload_file
from media_worker.transcription import transcribe


def test_production_configuration_fails_closed_and_accepts_complete_runtime():
    local = Settings.from_env()
    complete = replace(
        local,
        app_env="production",
        redis_url="rediss://redis.example.test:6379",
        s3_endpoint_url="https://account.r2.cloudflarestorage.com",
        s3_access_key_id="access",
        s3_secret_access_key="secret",
        s3_bucket="bucket",
        internal_token="internal-token",
        enable_ai=True,
        enable_whisperx=True,
        diarization_enabled=False,
    )
    complete.validate()
    with pytest.raises(RuntimeError, match="Missing required worker configuration"):
        replace(
            complete,
            redis_url="",
            enable_ai=False,
            diarization_enabled=True,
            hf_token="",
        ).validate()


def test_runtime_tuning_environment(monkeypatch):
    monkeypatch.setenv("MEDIA_MAX_CONCURRENT_JOBS", "2")
    monkeypatch.setenv("MEDIA_HEAVY_CONCURRENT_JOBS", "2")
    monkeypatch.setenv("MEDIA_LIGHT_CONCURRENT_JOBS", "4")
    monkeypatch.setenv("FFMPEG_PRESET", "veryfast")
    monkeypatch.setenv("FFMPEG_CRF", "22")
    monkeypatch.setenv("YTDLP_FRAGMENT_CONCURRENCY", "4")

    settings = Settings.from_env()

    assert settings.max_concurrent_jobs == 2
    assert settings.heavy_concurrent_jobs == 2
    assert settings.light_concurrent_jobs == 4
    assert settings.ffmpeg_preset == "veryfast"
    assert settings.ffmpeg_crf == 22
    assert settings.ytdlp_fragment_concurrency == 4


def test_process_runner_success_json_and_failures(monkeypatch):
    assert require_binary("python3")
    assert run_command(["python3", "-c", "print('ok')"]).strip() == b"ok"
    assert run_command(["python3", "-c", "import json; print(json.dumps({'ok': True}))"], capture_json=True) == {"ok": True}
    with pytest.raises(ValueError):
        run_command([])
    with pytest.raises(DependencyUnavailable):
        require_binary("definitely-missing-binary")
    with pytest.raises(WorkerError, match="invalid JSON"):
        run_command(["python3", "-c", "print('not-json')"], capture_json=True)
    with pytest.raises(WorkerError, match="exited with status"):
        run_command(["python3", "-c", "raise SystemExit(2)"])
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: (_ for _ in ()).throw(subprocess.TimeoutExpired("cmd", 1)))
    with pytest.raises(WorkerError, match="timeout"):
        run_command(["python3", "-c", "pass"], timeout=1)


def test_storage_upload_and_error_paths(tmp_path, monkeypatch):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"video")
    settings = replace(
        Settings.from_env(), s3_endpoint_url="http://storage", s3_access_key_id="access",
        s3_secret_access_key="secret", s3_bucket="bucket", s3_force_path_style=True,
    )

    class Client:
        def upload_file(self, *_args, **_kwargs):
            return None

        def head_object(self, **_kwargs):
            return {"ETag": '"etag"', "ContentLength": 5}

    fake_boto = SimpleNamespace(client=lambda *_args, **_kwargs: Client())
    monkeypatch.setitem(sys.modules, "boto3", fake_boto)
    monkeypatch.setitem(sys.modules, "botocore", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "botocore.config", SimpleNamespace(Config=lambda **_kwargs: object()))
    result = upload_file(path, "bucket", "exports/clip.mp4", settings)
    assert result == {"bucket": "bucket", "key": "exports/clip.mp4", "etag": "etag", "bytes": 5, "mediaType": "video/mp4"}
    with pytest.raises(WorkerError, match="not configured"):
        upload_file(path, "bucket", "key", replace(settings, s3_endpoint_url=""))

    class BrokenClient(Client):
        def upload_file(self, *_args, **_kwargs):
            raise RuntimeError("storage down")

    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda *_args, **_kwargs: BrokenClient()))
    with pytest.raises(WorkerError, match="Unable to export"):
        upload_file(path, "bucket", "key", settings)


def test_transcription_normalizes_real_whisperx_contract(tmp_path, monkeypatch):
    media = tmp_path / "source.mp4"
    media.write_bytes(b"video")

    class Model:
        def transcribe(self, _audio, **_kwargs):
            return {"language": "en", "segments": [{"start": 0, "end": 2, "text": " hello"}]}

    fake = SimpleNamespace(
        load_audio=lambda _path: [0.0], load_model=lambda *_args, **_kwargs: Model(),
        load_align_model=lambda **_kwargs: (object(), {}),
        align=lambda *_args, **_kwargs: {"segments": [{"start": 0, "end": 2, "text": " hello", "speaker": None, "words": [{"word": " hello", "start": 0.1, "end": 0.8, "score": 0.9}, {"word": "skip"}]}]},
    )
    monkeypatch.setitem(sys.modules, "whisperx", fake)
    settings = replace(Settings.from_env(), whisper_model="tiny", whisper_device="cpu", whisper_compute_type="int8", diarization_enabled=False)
    result = transcribe(media, settings, {"batchSize": 1, "diarize": False})
    assert result["language"] == "en"
    assert result["confidence"] == 0.9
    assert result["segments"][0]["words"][0]["word"] == "hello"

    with pytest.raises(WorkerError, match="HF_TOKEN"):
        transcribe(media, replace(settings, hf_token=""), {"diarize": True})
    fake.align = lambda *_args, **_kwargs: {"segments": []}
    with pytest.raises(WorkerError, match="no speech"):
        transcribe(media, settings, {"diarize": False})
    fake.load_audio = lambda _path: (_ for _ in ()).throw(RuntimeError("model failed\nunsafe"))
    with pytest.raises(WorkerError, match="model failed unsafe"):
        transcribe(media, settings, {"diarize": False})


def test_rendering_builds_caption_and_watermark_commands(tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"source")
    caption = tmp_path / "clip-001.ass"
    caption.write_text("caption")
    watermark = tmp_path / "watermark.png"
    watermark.write_bytes(b"png")
    commands = []

    def execute(command, **_kwargs):
        commands.append(command)
        Path(command[-1]).write_bytes(b"render")

    monkeypatch.setattr("media_worker.rendering.run_command", execute)
    settings = Settings.from_env()
    clips = [{"id": "clip-001", "start": 0, "end": 5}]
    captions = [{"clipId": "clip-001", "ass": str(caption)}]
    result = render_clips(source, clips, captions, tmp_path / "renders", settings, {"watermarkPath": str(watermark), "watermarkPosition": "32:32", "preset": "fast", "crf": 22})
    assert result[0]["durationSeconds"] == 5
    assert "-filter_complex" in commands[0]
    result = render_clips(source, clips, captions, tmp_path / "renders-plain", settings, {"watermarkText": "ClipBR AI"})
    assert "-vf" in commands[1]
    assert "drawtext" in ",".join(commands[1])
    with pytest.raises(WorkerError, match="non-positive"):
        render_clips(source, [{"id": "bad", "start": 5, "end": 5}], [], tmp_path / "bad", settings, {})
    with pytest.raises(Exception, match="artifact is missing"):
        render_clips(source, clips, captions, tmp_path / "missing", settings, {"watermarkPath": str(tmp_path / "missing.png")})
