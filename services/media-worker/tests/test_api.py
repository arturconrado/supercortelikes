from dataclasses import replace
from importlib import import_module
import sys
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from media_worker.app import app
from media_worker.errors import WorkerError
from media_worker.models import PipelineRequest


client = TestClient(app)


def test_liveness_contract():
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json()["service"] == "media-worker"


def test_metrics_endpoint_is_prometheus_compatible():
    response = client.get("/metrics")
    assert response.status_code == 200
    assert "text/plain" in response.headers["content-type"]
    assert "media_worker_" in response.text


def test_unknown_stage_returns_stable_error_contract():
    response = client.post(
        "/v1/stages/unknown",
        json={
            "schemaVersion": 1,
            "pipelineRunId": "pipeline-123",
            "stageExecutionId": "execution-123",
            "videoId": "video-123",
        },
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "UNKNOWN_STAGE"


def test_authorize_requires_matching_internal_bearer(monkeypatch):
    worker_app = import_module("media_worker.app")
    monkeypatch.setattr(
        worker_app,
        "settings",
        replace(worker_app.settings, internal_token="internal-token"),
    )

    worker_app.authorize("Bearer internal-token")
    with pytest.raises(WorkerError, match="valid internal bearer"):
        worker_app.authorize(None)
    with pytest.raises(WorkerError, match="valid internal bearer"):
        worker_app.authorize("Bearer wrong")


def test_readiness_requires_real_runtime_dependencies(monkeypatch):
    worker_app = import_module("media_worker.app")
    monkeypatch.setattr(
        worker_app,
        "settings",
        replace(
            worker_app.settings,
            redis_url="redis://localhost:6379/0",
            enable_whisperx=True,
            enable_opencv=True,
            enable_mediapipe=True,
            enable_yolo=True,
            diarization_enabled=True,
            hf_token="",
        ),
    )
    monkeypatch.setattr(
        worker_app,
        "_readiness_dependencies",
        lambda: {
            "ffmpeg": True,
            "ffprobe": True,
            "storage": True,
            "workspace": True,
            "modelCache": True,
            "redis": True,
            "whisperx": False,
            "opencv": True,
            "mediapipe": True,
            "yolo": True,
            "huggingFaceToken": False,
        },
    )

    response = client.get("/health/ready")
    body = response.json()

    assert response.status_code == 503
    assert body["status"] == "not-ready"
    assert "whisperx" in body["required"]
    assert "huggingFaceToken" in body["required"]


def test_readiness_passes_for_minimal_release_dependencies(monkeypatch):
    worker_app = import_module("media_worker.app")
    monkeypatch.setattr(
        worker_app,
        "settings",
        replace(
            worker_app.settings,
            redis_url="",
            enable_whisperx=False,
            enable_opencv=False,
            enable_mediapipe=False,
            enable_yolo=False,
            diarization_enabled=False,
        ),
    )
    monkeypatch.setattr(
        worker_app,
        "_readiness_dependencies",
        lambda: {
            "ffmpeg": True,
            "ffprobe": True,
            "storage": True,
            "workspace": True,
            "modelCache": False,
            "redis": False,
            "whisperx": False,
            "opencv": False,
            "mediapipe": False,
            "yolo": False,
            "huggingFaceToken": False,
        },
    )

    response = client.get("/health/ready")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ready"
    assert body["required"] == ["ffmpeg", "ffprobe", "storage", "workspace"]


def test_storage_and_redis_readiness_paths(monkeypatch):
    worker_app = import_module("media_worker.app")
    base = replace(
        worker_app.settings,
        s3_endpoint_url="http://storage",
        s3_access_key_id="access",
        s3_secret_access_key="secret",
        s3_bucket="bucket",
        redis_url="redis://localhost:6379/0",
    )
    monkeypatch.setattr(worker_app, "settings", base)

    class S3Client:
        def head_bucket(self, **_kwargs):
            return None

    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda *_args, **_kwargs: S3Client()))
    monkeypatch.setitem(sys.modules, "botocore", SimpleNamespace())
    monkeypatch.setitem(sys.modules, "botocore.config", SimpleNamespace(Config=lambda **_kwargs: object()))
    assert worker_app._storage_ready() is True
    monkeypatch.setattr(worker_app, "settings", replace(base, s3_bucket=""))
    assert worker_app._storage_ready() is False

    class RedisClient:
        def ping(self):
            return True

    monkeypatch.setattr(worker_app, "settings", base)
    monkeypatch.setitem(
        sys.modules,
        "redis",
        SimpleNamespace(Redis=SimpleNamespace(from_url=lambda *_args, **_kwargs: RedisClient())),
    )
    assert worker_app._redis_ready() is True
    monkeypatch.setattr(worker_app, "settings", replace(base, redis_url=""))
    assert worker_app._redis_ready() is False


def test_source_is_explicitly_required_for_ingestion(tmp_path, monkeypatch):
    from media_worker.app import pipeline

    monkeypatch.setattr(
        pipeline, "settings", replace(pipeline.settings, data_dir=tmp_path)
    )
    response = client.post(
        "/v1/stages/ingestion",
        json={
            "schemaVersion": 1,
            "pipelineRunId": "pipeline-no-source",
            "stageExecutionId": "execution-no-source",
            "videoId": "video-no-source",
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SOURCE_REQUIRED"


def test_source_workspace_is_preserved_for_later_clip_edits(tmp_path, monkeypatch):
    worker_app = import_module("media_worker.app")
    run = tmp_path / "pipeline-source"
    run.mkdir()
    monkeypatch.setattr(worker_app, "settings", replace(worker_app.settings, data_dir=tmp_path, retain_downloads=False))
    monkeypatch.setattr(worker_app.pipeline, "execute", lambda *_args: {"status": "succeeded"})
    result = worker_app._run_stage("exports", PipelineRequest(
        pipelineRunId="pipeline-source", stageExecutionId="execution-source", videoId="video-source",
        options={"sourcePipelineRunId": "pipeline-source"},
    ))
    assert result == {"status": "succeeded"}
    assert run.exists()


def test_completed_on_demand_export_workspace_is_removed_when_retention_is_disabled(tmp_path, monkeypatch):
    worker_app = import_module("media_worker.app")
    run = tmp_path / "pipeline-render"
    run.mkdir()
    monkeypatch.setattr(worker_app, "settings", replace(worker_app.settings, data_dir=tmp_path, retain_downloads=False))
    monkeypatch.setattr(worker_app.pipeline, "execute", lambda *_args: {"status": "succeeded"})
    result = worker_app._run_stage("exports", PipelineRequest(
        pipelineRunId="pipeline-render", stageExecutionId="execution-render", videoId="video-render",
        options={"sourcePipelineRunId": "pipeline-source"},
    ))
    assert result == {"status": "succeeded"}
    assert not run.exists()


def test_authenticated_workspace_cleanup_removes_only_requested_pipeline_directories(tmp_path, monkeypatch):
    worker_app = import_module("media_worker.app")
    first = tmp_path / "pipeline-cleanup-one"
    second = tmp_path / "pipeline-cleanup-two"
    first.mkdir()
    second.mkdir()
    monkeypatch.setattr(worker_app, "settings", replace(worker_app.settings, data_dir=tmp_path, internal_token="cleanup-token"))

    response = client.post(
        "/v1/workspaces/cleanup",
        headers={"Authorization": "Bearer cleanup-token"},
        json={"pipelineRunIds": ["pipeline-cleanup-one"]},
    )

    assert response.status_code == 200
    assert response.json() == {"requested": 1, "removed": 1}
    assert not first.exists()
    assert second.exists()
