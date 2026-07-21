import json
from types import SimpleNamespace

from media_worker import deepgram, runpod
from media_worker.errors import WorkerError
from media_worker.models import ArtifactDescriptor, ArtifactLocation, PipelineRequest
from media_worker.pipeline import Pipeline
from media_worker.quality import conservative_compositions
from media_worker.workspace import Workspace


def test_deepgram_normalizes_word_timestamps_and_speakers(monkeypatch):
    captured = {}

    def response(request, _timeout):
        captured["url"] = request.full_url
        captured["body"] = json.loads(request.data)
        return {
            "metadata": {"duration": 2.5, "request_id": "dg-request"},
            "results": {
                "channels": [{"alternatives": [{
                    "confidence": 0.9,
                    "words": [
                        {"word": "ola", "punctuated_word": "Olá", "start": 0, "end": 0.5, "confidence": 0.95, "speaker": 0},
                        {"word": "mundo", "start": 0.6, "end": 1.2, "confidence": 0.85, "speaker": 0},
                    ],
                }]}],
                "utterances": [{"start": 0, "end": 1.2, "speaker": 0, "transcript": "Olá mundo"}],
            },
        }

    monkeypatch.setattr(deepgram, "_request_json", response)
    settings = SimpleNamespace(
        deepgram_model="nova-3",
        deepgram_language="pt-BR",
        deepgram_api_key="secret",
        deepgram_timeout_seconds=30,
        deepgram_cost_usd_per_hour=0.36,
    )
    value = deepgram.transcribe_url("https://storage.test/source.mp4", settings, {})

    assert captured["body"] == {"url": "https://storage.test/source.mp4"}
    assert "diarize_model=v2" in captured["url"]
    assert value["engine"] == "deepgram"
    assert value["speakerCount"] == 1
    assert value["segments"][0]["speaker"] == "SPEAKER_00"
    assert value["segments"][0]["words"][0]["start"] == 0.0
    assert value["providerUsage"][0]["requestId"] == "dg-request"


def test_runpod_resumes_persisted_job_without_resubmitting(tmp_path, monkeypatch):
    workspace = Workspace(tmp_path, "pipeline-123")
    workspace.write_json(
        "remote/runpod-rendering.json",
        {"jobId": "remote-123", "idempotencyKey": "stage-123", "status": "IN_QUEUE"},
    )
    monkeypatch.setattr(runpod, "_submit", lambda *_: (_ for _ in ()).throw(AssertionError("must resume")))
    monkeypatch.setattr(runpod, "_status", lambda *_: {
        "status": "COMPLETED",
        "executionTime": 5000,
        "output": {"renders": [], "storage": [], "metrics": {}},
    })
    settings = SimpleNamespace(
        gpu_provider="runpod",
        runpod_timeout_seconds=60,
        runpod_poll_seconds=0.01,
        runpod_cost_usd_per_second=0.001,
        remote_max_concurrency=2,
    )

    value = runpod.execute_remote_job(
        workspace,
        "rendering",
        {"idempotencyKey": "stage-123"},
        settings,
    )

    assert value["providerUsage"][0]["requestId"] == "remote-123"
    assert value["providerUsage"][0]["quantity"] == 5.0
    assert value["providerUsage"][0]["costUsd"] == 0.005


def test_runpod_uncertain_submission_falls_back_without_duplicate_charge(tmp_path):
    workspace = Workspace(tmp_path, "pipeline-uncertain")
    workspace.write_json(
        "remote/runpod-composition.json",
        {"idempotencyKey": "stage-uncertain", "status": "SUBMITTING"},
    )
    settings = SimpleNamespace(gpu_provider="runpod", remote_max_concurrency=2)

    try:
        runpod.execute_remote_job(
            workspace,
            "composition",
            {"idempotencyKey": "stage-uncertain"},
            settings,
        )
        assert False, "uncertain submissions must not be submitted again"
    except WorkerError as error:
        assert error.code == "RUNPOD_SUBMISSION_UNCERTAIN"


def test_object_artifacts_select_stage_response_v2():
    request = PipelineRequest.model_validate({
        "pipelineRunId": "pipeline-123",
        "stageExecutionId": "stage-123",
        "videoId": "video-123",
    })
    artifact = ArtifactDescriptor(
        kind="rendered-clip",
        location=ArtifactLocation(type="object", bucket="videos", key="exports/clip.mp4"),
        sha256="a" * 64,
        bytes=10,
        media_type="video/mp4",
    )

    response = Pipeline._response(request, "rendering", [artifact], {})
    serialized = response.model_dump(mode="json", by_alias=True, exclude_none=True)

    assert response.schema_version == 2
    assert "path" not in serialized["artifacts"][0]
    assert serialized["artifacts"][0]["location"] == {
        "type": "object", "bucket": "videos", "key": "exports/clip.mp4"
    }


def test_visual_qa_conservative_rerender_preserves_other_clips():
    plans = {
        "clip-001": {"scenes": [{"layout": "fill", "keyframes": [{"at": 0}]}], "diagnostics": {"status": "ready"}},
        "clip-002": {"scenes": [{"layout": "split", "keyframes": []}], "diagnostics": {"status": "ready"}},
    }

    value = conservative_compositions(plans, ["clip-001"])

    assert value["clip-001"]["scenes"][0]["layout"] == "fit"
    assert value["clip-001"]["diagnostics"]["reason"] == "visual-qa-rerender"
    assert value["clip-002"] == plans["clip-002"]
