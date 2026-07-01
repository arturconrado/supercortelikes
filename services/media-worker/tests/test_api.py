from fastapi.testclient import TestClient
from dataclasses import replace
from importlib import import_module

from media_worker.app import app
from media_worker.models import PipelineRequest


client = TestClient(app)


def test_liveness_contract():
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json()["service"] == "media-worker"


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


def test_completed_export_workspace_is_removed_when_retention_is_disabled(tmp_path, monkeypatch):
    worker_app = import_module("media_worker.app")
    run = tmp_path / "pipeline-cleanup"
    run.mkdir()
    monkeypatch.setattr(worker_app, "settings", replace(worker_app.settings, data_dir=tmp_path, retain_downloads=False))
    monkeypatch.setattr(worker_app.pipeline, "execute", lambda *_args: {"status": "succeeded"})
    result = worker_app._run_stage("exports", PipelineRequest(
        pipelineRunId="pipeline-cleanup", stageExecutionId="execution-cleanup", videoId="video-cleanup",
    ))
    assert result == {"status": "succeeded"}
    assert not run.exists()
