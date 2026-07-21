import hashlib
import io
import json
import sys
import types
import urllib.error
from types import SimpleNamespace

import pytest

sys.modules.setdefault(
    "runpod",
    types.SimpleNamespace(serverless=types.SimpleNamespace(start=lambda *_args, **_kwargs: None)),
)

from media_worker import deepgram, runpod
from media_worker import quality, runpod_handler
from media_worker.errors import WorkerError
from media_worker.models import ArtifactDescriptor, ArtifactLocation, PipelineRequest
from media_worker.pipeline import Pipeline
from media_worker.quality import conservative_compositions
from media_worker.workspace import Workspace


class JsonResponse:
    def __init__(self, value, headers=None):
        self.value = value
        self.headers = headers or {}
        self.consumed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, *_args):
        if isinstance(self.value, bytes):
            if self.consumed:
                return b""
            self.consumed = True
            return self.value
        return json.dumps(self.value).encode("utf-8")


def external_settings(**overrides):
    values = {
        "deepgram_model": "nova-3",
        "deepgram_language": "pt-BR",
        "deepgram_api_key": "secret",
        "deepgram_timeout_seconds": 30,
        "deepgram_cost_usd_per_hour": 0.36,
        "gpu_provider": "runpod",
        "runpod_timeout_seconds": 60,
        "runpod_poll_seconds": 0.0,
        "runpod_cost_usd_per_second": 0.001,
        "runpod_endpoint_id": "endpoint",
        "runpod_api_key": "secret",
        "remote_max_concurrency": 2,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


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


def test_deepgram_rejects_invalid_sources_and_payloads(monkeypatch):
    settings = external_settings()
    with pytest.raises(WorkerError) as invalid_source:
        deepgram.transcribe_url("file:///source.mp4", settings, {})
    assert invalid_source.value.code == "DEEPGRAM_SOURCE_URL_REQUIRED"

    monkeypatch.setattr(deepgram, "_request_json", lambda *_: {"results": {}})
    with pytest.raises(WorkerError) as invalid_response:
        deepgram.transcribe_url("https://storage.test/source.mp4", settings, {})
    assert invalid_response.value.code == "DEEPGRAM_RESPONSE_INVALID"

    monkeypatch.setattr(deepgram, "_request_json", lambda *_: {
        "metadata": {},
        "results": {"channels": [{"alternatives": [{"words": []}]}]},
    })
    with pytest.raises(WorkerError) as empty:
        deepgram.transcribe_url("https://storage.test/source.mp4", settings, {})
    assert empty.value.code == "TRANSCRIPT_EMPTY"


def test_deepgram_uses_alternative_confidence_and_word_groups(monkeypatch):
    settings = external_settings()
    monkeypatch.setattr(deepgram, "_request_json", lambda *_: {
        "metadata": {"requestId": "fallback-id"},
        "results": {
            "channels": [{"alternatives": [{"confidence": 0.77, "words": []}]}],
            "utterances": [{"start": 0.2, "end": 1.0, "transcript": "fala"}],
        },
    })
    value = deepgram.transcribe_url(
        "https://storage.test/source.mp4",
        settings,
        {"model": "custom", "language": "pt"},
    )
    assert value["confidence"] == 0.77
    assert value["durationSeconds"] == 1.0
    assert value["speakerCount"] == 0
    assert value["providerUsage"][0]["requestId"] == "fallback-id"

    words = deepgram._normalize_words([
        {"word": "ignored", "end": 0.2},
        {"word": "um", "start": 0, "end": 0.2},
        {"word": "dois", "start": 0.3, "end": 0.5},
        {"word": "tres", "start": 1.5, "end": 1.8, "speaker": 1},
    ])
    segments = deepgram._segments([], words)
    assert [segment["text"] for segment in segments] == ["um dois", "tres"]
    assert deepgram._segments([], []) == []
    assert deepgram._optional_float(None) is None
    assert deepgram._optional_float("1.234567") == 1.23457


def test_deepgram_request_retries_and_error_mapping(monkeypatch):
    request = SimpleNamespace()
    monkeypatch.setattr(deepgram.time, "sleep", lambda *_: None)
    responses = iter([JsonResponse([]), JsonResponse({"ok": True})])
    monkeypatch.setattr(deepgram.urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    assert deepgram._request_json(request, 1) == {"ok": True}

    def http_error(code, body=b"provider\nerror", headers=None):
        return urllib.error.HTTPError("https://provider.test", code, "error", headers or {}, io.BytesIO(body))

    monkeypatch.setattr(
        deepgram.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(http_error(400)),
    )
    with pytest.raises(WorkerError) as failed:
        deepgram._request_json(request, 1)
    assert failed.value.code == "DEEPGRAM_FAILED"
    assert failed.value.detail["response"] == "provider error"

    monkeypatch.setattr(
        deepgram.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(http_error(429, headers={"retry-after": "0"})),
    )
    with pytest.raises(WorkerError) as rate_limited:
        deepgram._request_json(request, 1)
    assert rate_limited.value.code == "DEEPGRAM_RATE_LIMITED"

    monkeypatch.setattr(
        deepgram.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )
    with pytest.raises(WorkerError) as unavailable:
        deepgram._request_json(request, 1)
    assert unavailable.value.code == "DEEPGRAM_UNAVAILABLE"

    assert deepgram._retry_after(http_error(429, headers={"retry-after": "99"}), 0) == 10.0
    assert deepgram._retry_after(http_error(429), 1) == 2.0

    broken = http_error(500)
    broken.read = lambda *_: (_ for _ in ()).throw(OSError("broken"))
    assert deepgram._safe_http_body(broken) == ""


def test_runpod_guards_concurrency_and_invalid_configuration(tmp_path, monkeypatch):
    workspace = Workspace(tmp_path, "pipeline-guard")
    with pytest.raises(WorkerError) as disabled:
        runpod.execute_remote_job(workspace, "rendering", {"idempotencyKey": "id"}, external_settings(gpu_provider="none"))
    assert disabled.value.code == "RUNPOD_DISABLED"

    with pytest.raises(WorkerError) as missing_id:
        runpod.execute_remote_job(workspace, "rendering", {}, external_settings())
    assert missing_id.value.code == "RUNPOD_IDEMPOTENCY_REQUIRED"

    saturated = SimpleNamespace(acquire=lambda **_kwargs: False, release=lambda: None)
    monkeypatch.setattr(runpod, "_capacity", lambda *_: saturated)
    with pytest.raises(WorkerError) as concurrency:
        runpod.execute_remote_job(workspace, "rendering", {"idempotencyKey": "id"}, external_settings())
    assert concurrency.value.code == "RUNPOD_CONCURRENCY_LIMIT"


def test_runpod_submits_new_jobs_and_uses_gpu_metrics(tmp_path, monkeypatch):
    workspace = Workspace(tmp_path, "pipeline-submit")
    monkeypatch.setattr(runpod, "_submit", lambda *_: "job-new")
    monkeypatch.setattr(runpod, "_status", lambda *_: {
        "status": "COMPLETED",
        "executionTime": 9999,
        "output": {
            "providerUsage": [{"provider": "openrouter"}],
            "metrics": {"gpuSeconds": 2.5, "costUsd": 0.01, "model": "gpu-model"},
        },
    })
    value = runpod.execute_remote_job(
        workspace,
        "rendering",
        {"idempotencyKey": "new-key"},
        external_settings(),
    )
    assert value["providerUsage"][-1]["quantity"] == 2.5
    assert value["providerUsage"][-1]["costUsd"] == 0.01
    assert value["providerUsage"][-1]["model"] == "gpu-model"


def test_runpod_maps_invalid_terminal_and_timeout_states(tmp_path, monkeypatch):
    settings = external_settings()
    workspace = Workspace(tmp_path, "pipeline-states")
    workspace.write_json("remote/runpod-rendering.json", {
        "jobId": "job", "idempotencyKey": "key", "status": "IN_QUEUE"
    })

    monkeypatch.setattr(runpod, "_status", lambda *_: {"status": "COMPLETED", "output": []})
    with pytest.raises(WorkerError) as invalid:
        runpod.execute_remote_job(workspace, "rendering", {"idempotencyKey": "key"}, settings)
    assert invalid.value.code == "RUNPOD_RESPONSE_INVALID"

    monkeypatch.setattr(runpod, "_status", lambda *_: {
        "status": "FAILED", "error": "gpu failed", "executionTime": 1200
    })
    with pytest.raises(WorkerError) as failed:
        runpod.execute_remote_job(workspace, "rendering", {"idempotencyKey": "key"}, settings)
    assert failed.value.code == "RUNPOD_JOB_FAILED"
    assert failed.value.detail["providerUsage"][0]["quantity"] == 1.2

    workspace.write_json("remote/runpod-rendering.json", {
        "jobId": "job", "idempotencyKey": "key", "status": "IN_QUEUE"
    })
    with pytest.raises(WorkerError) as timeout:
        runpod.execute_remote_job(
            workspace,
            "rendering",
            {"idempotencyKey": "key"},
            external_settings(runpod_timeout_seconds=0),
        )
    assert timeout.value.code == "RUNPOD_TIMEOUT"


def test_runpod_http_helpers_cover_provider_failures(tmp_path, monkeypatch):
    settings = external_settings()
    request_json = runpod._request_json
    monkeypatch.setattr(runpod.time, "sleep", lambda *_: None)
    monkeypatch.setattr(runpod, "_request_json", lambda *_args, **_kwargs: {"id": "job-id"})
    assert runpod._submit({"value": 1}, settings) == "job-id"
    monkeypatch.setattr(runpod, "_request_json", lambda *_args, **_kwargs: {})
    with pytest.raises(WorkerError) as invalid:
        runpod._submit({}, settings)
    assert invalid.value.code == "RUNPOD_RESPONSE_INVALID"

    monkeypatch.setattr(runpod, "_request_json", request_json)
    responses = iter([JsonResponse([]), JsonResponse({"ok": True})])
    monkeypatch.setattr(runpod.urllib.request, "urlopen", lambda *_args, **_kwargs: next(responses))
    assert runpod._request_json("https://runpod.test", settings, body={"a": 1}) == {"ok": True}

    def http_error(code):
        return urllib.error.HTTPError("https://runpod.test", code, "error", {}, io.BytesIO())

    monkeypatch.setattr(
        runpod.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(http_error(400)),
    )
    with pytest.raises(WorkerError) as request_failed:
        runpod._request_json("https://runpod.test", settings)
    assert request_failed.value.code == "RUNPOD_REQUEST_FAILED"

    monkeypatch.setattr(
        runpod.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(http_error(429)),
    )
    with pytest.raises(WorkerError) as rate_limited:
        runpod._request_json("https://runpod.test", settings)
    assert rate_limited.value.code == "RUNPOD_RATE_LIMITED"

    monkeypatch.setattr(
        runpod.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(urllib.error.URLError("offline")),
    )
    with pytest.raises(WorkerError) as unavailable:
        runpod._request_json("https://runpod.test", settings)
    assert unavailable.value.code == "RUNPOD_UNAVAILABLE"

    workspace = Workspace(tmp_path, "pipeline-state-errors")
    workspace.path("remote/runpod-rendering.json").parent.mkdir(parents=True, exist_ok=True)
    workspace.path("remote/runpod-rendering.json").write_text("not-json", encoding="utf-8")
    assert runpod._load_state(workspace, "remote/runpod-rendering.json") == {}


def qa_settings(**overrides):
    values = {
        "openrouter_qa_enabled": True,
        "llm_provider": "openrouter",
        "llm_api_key": "secret",
        "openrouter_editor_model": "google/gemini-2.5-flash",
        "llm_provider_sort": "latency",
        "llm_timeout_seconds": 5,
        "ffmpeg_binary": "ffmpeg",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_visual_qa_early_exits_and_contact_sheet_failure(tmp_path, monkeypatch):
    assert quality.review_renders([], qa_settings(openrouter_qa_enabled=False), tmp_path) is None
    assert quality.review_renders([], qa_settings(llm_provider="none"), tmp_path) is None
    assert quality.review_renders([], qa_settings(llm_api_key=""), tmp_path) is None
    assert quality.review_renders([], qa_settings(), tmp_path, cost_remaining_usd=0) is None
    assert quality.review_renders([{"path": tmp_path / "missing.mp4"}], qa_settings(), tmp_path) is None

    render = tmp_path / "render.mp4"
    render.write_bytes(b"video")
    monkeypatch.setattr(quality, "_contact_sheet", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("ffmpeg")))
    assert quality.review_renders([{"path": render, "clipId": "a"}], qa_settings(), tmp_path) is None


def test_visual_qa_normalizes_reviews_and_usage(tmp_path, monkeypatch):
    render = tmp_path / "render.mp4"
    render.write_bytes(b"video")

    def contact_sheet(_path, clip_id, _duration, output_dir, _settings):
        output_dir.mkdir(parents=True, exist_ok=True)
        sheet = output_dir / (clip_id + ".jpg")
        sheet.write_bytes(b"jpeg")
        return sheet

    body = {
        "choices": [{"message": {"content": "```json\n" + json.dumps({
            "reviews": [
                {"clipId": "clip-1", "passed": True, "issues": ["face_cut", "unknown"], "confidence": 2},
                {"clipId": "other", "passed": False},
                "invalid",
            ]
        }) + "\n```"}}],
        "usage": {"total_tokens": 20, "cost": 0.002},
    }
    monkeypatch.setattr(quality, "_contact_sheet", contact_sheet)
    monkeypatch.setattr(quality.urllib.request, "urlopen", lambda *_args, **_kwargs: JsonResponse(body))
    value = quality.review_renders(
        [{"path": render, "clipId": "clip-1", "durationSeconds": 0}],
        qa_settings(),
        tmp_path / "sheets",
        cost_remaining_usd=1,
    )
    assert value["failedClipIds"] == ["clip-1"]
    assert value["reviews"][0]["issues"] == ["face_cut"]
    assert value["reviews"][0]["confidence"] == 1.0
    assert value["providerUsage"][0]["requestId"].startswith("openrouter-qa-")
    assert value["providerUsage"][0]["costUsd"] == 0.002

    monkeypatch.setattr(quality.urllib.request, "urlopen", lambda *_args, **_kwargs: JsonResponse([]))
    assert quality.review_renders(
        [{"path": render, "clipId": "clip-1", "durationSeconds": 1}],
        qa_settings(),
        tmp_path / "sheets-invalid",
    ) is None


def test_visual_qa_helpers_cover_default_and_invalid_values(tmp_path, monkeypatch):
    assert quality._json_content('{"reviews": []}') == {"reviews": []}
    with pytest.raises(ValueError):
        quality._json_content("[]")
    assert quality._reviews({"reviews": "invalid"}, ["clip"])[0]["passed"] is True
    assert quality._reviews({"reviews": [{"clipId": "clip", "confidence": -1}]}, ["clip"])[0]["confidence"] == 0
    assert quality._cost({"cost": "invalid", "total_cost": "1.25"}) == 1.25
    assert quality._cost({}) == 0
    assert quality._response_id({"b": 2, "a": 1}).startswith("openrouter-qa-")

    captured = {}
    monkeypatch.setattr(quality, "run_command", lambda command, timeout: captured.update(command=command, timeout=timeout))
    destination = quality._contact_sheet(tmp_path / "in.mp4", "clip/unsafe", 2, tmp_path / "out", qa_settings())
    assert destination.name == "clip-unsafe.jpg"
    assert captured["timeout"] == 180


def test_runpod_handler_validates_input_and_helper_contracts(tmp_path, monkeypatch):
    settings = SimpleNamespace(max_download_bytes=8, runpod_cost_usd_per_second=0.001)
    monkeypatch.setattr(runpod_handler, "Settings", SimpleNamespace(from_env=lambda: settings))
    with pytest.raises(WorkerError) as invalid_input:
        runpod_handler.handler({"input": "invalid"})
    assert invalid_input.value.code == "RUNPOD_INPUT_INVALID"
    with pytest.raises(WorkerError) as invalid_job:
        runpod_handler.handler({"input": {"jobType": "other", "clips": [], "options": {}}})
    assert invalid_job.value.code == "RUNPOD_JOB_INVALID"
    with pytest.raises(WorkerError) as missing_options:
        runpod_handler.handler({"input": {"jobType": "render", "clips": {}}})
    assert missing_options.value.code == "RUNPOD_INPUT_INVALID"

    assert runpod_handler._materialize_captions(None, tmp_path / "none") == []
    captions = runpod_handler._materialize_captions(
        [None, {}, {"clipId": "clip", "ass": "ass", "srt": "srt"}],
        tmp_path / "captions",
    )
    assert len(captions) == 1
    assert (tmp_path / "captions" / "clip.ass").read_text() == "ass"
    assert runpod_handler._optional_float(None) is None
    assert runpod_handler._optional_float("1.5") == 1.5
    assert runpod_handler._optional_float("invalid") is None
    assert runpod_handler._remaining_after_usage(None, []) is None
    assert runpod_handler._remaining_after_usage(1, [{"costUsd": 0.25}, {"costUsd": -1}]) == 0.75
    assert runpod_handler._remaining_after_gpu(None, 0, settings) is None


def test_runpod_handler_download_and_upload_guards(tmp_path, monkeypatch):
    with pytest.raises(WorkerError) as invalid_source:
        runpod_handler._download("http://unsafe.test/source", tmp_path / "source", 10)
    assert invalid_source.value.code == "RUNPOD_SOURCE_URL_INVALID"

    monkeypatch.setattr(
        runpod_handler.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: JsonResponse(b"large", {"content-length": "20"}),
    )
    with pytest.raises(WorkerError) as declared_large:
        runpod_handler._download("https://safe.test/source", tmp_path / "declared", 10)
    assert declared_large.value.code == "RUNPOD_SOURCE_TOO_LARGE"

    monkeypatch.setattr(
        runpod_handler.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: JsonResponse(b"too-large", {}),
    )
    with pytest.raises(WorkerError) as streamed_large:
        runpod_handler._download("https://safe.test/source", tmp_path / "streamed", 3)
    assert streamed_large.value.code == "RUNPOD_SOURCE_TOO_LARGE"

    monkeypatch.setattr(
        runpod_handler.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: JsonResponse(b"", {}),
    )
    with pytest.raises(WorkerError) as empty:
        runpod_handler._download("https://safe.test/source", tmp_path / "empty", 10)
    assert empty.value.code == "RUNPOD_SOURCE_EMPTY"

    monkeypatch.setattr(
        runpod_handler.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: JsonResponse(b"ok", {}),
    )
    downloaded = runpod_handler._download("https://safe.test/source", tmp_path / "ok", 10)
    assert downloaded.read_bytes() == b"ok"

    with pytest.raises(WorkerError) as invalid_upload:
        runpod_handler._upload("http://unsafe.test/upload", downloaded, "video/mp4")
    assert invalid_upload.value.code == "RUNPOD_UPLOAD_URL_INVALID"

    class Connection:
        statuses = [500, 204]
        closed = 0

        def __init__(self, *_args, **_kwargs):
            self.status = self.statuses.pop(0)

        def request(self, *_args, **_kwargs):
            return None

        def getresponse(self):
            return SimpleNamespace(status=self.status, read=lambda: b"")

        def close(self):
            Connection.closed += 1

    monkeypatch.setattr(runpod_handler.http.client, "HTTPSConnection", Connection)
    with pytest.raises(WorkerError) as upload_failed:
        runpod_handler._upload("https://safe.test/upload?signature=x", downloaded, "video/mp4")
    assert upload_failed.value.code == "RUNPOD_UPLOAD_FAILED"
    runpod_handler._upload("https://safe.test/upload", downloaded, "video/mp4")
    assert Connection.closed == 2


def test_runpod_handler_composition_and_render_paths(tmp_path, monkeypatch):
    settings = SimpleNamespace(max_download_bytes=100, runpod_cost_usd_per_second=0.001)
    monkeypatch.setattr(runpod_handler, "Settings", SimpleNamespace(from_env=lambda: settings))

    def download(_url, destination, _maximum):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(b"source")
        return destination

    monkeypatch.setattr(runpod_handler, "_download", download)
    captured = {}

    def build(_source, clips, _settings, options):
        captured["options"] = options
        return [{"clipId": str(clip["id"]), "scenes": []} for clip in clips]

    monkeypatch.setattr(runpod_handler, "build_compositions", build)
    composition = runpod_handler.handler({"input": {
        "jobType": "composition",
        "sourceUrl": "https://safe.test/source",
        "sourceSha256": hashlib.sha256(b"source").hexdigest(),
        "clips": [{"id": "clip"}],
        "options": {"analysisFps": 10, "watermarkUrl": "https://safe.test/watermark"},
    }})
    assert composition["compositions"][0]["clipId"] == "clip"
    assert captured["options"]["sampleSeconds"] == 0.1
    assert captured["options"]["watermarkPath"].endswith("watermark.png")

    with pytest.raises(WorkerError) as checksum:
        runpod_handler.handler({"input": {
            "jobType": "composition",
            "sourceUrl": "https://safe.test/source",
            "sourceSha256": "0" * 64,
            "clips": [],
            "options": {},
        }})
    assert checksum.value.code == "RUNPOD_SOURCE_CHECKSUM_MISMATCH"

    render_calls = []

    def render(_source, clips, _captions, output_dir, _settings, _options):
        render_calls.append([str(clip["id"]) for clip in clips])
        output_dir.mkdir(parents=True, exist_ok=True)
        values = []
        for clip in clips:
            path = output_dir / (str(clip["id"]) + ".mp4")
            path.write_bytes(b"render")
            values.append({"clipId": str(clip["id"]), "path": str(path), "durationSeconds": 2})
        return values

    reviews = iter([
        {"failedClipIds": ["clip"], "providerUsage": [{"costUsd": 0.001}]},
        {"failedClipIds": [], "providerUsage": [{"costUsd": 0.001}]},
    ])
    monkeypatch.setattr(runpod_handler, "render_clips", render)
    monkeypatch.setattr(runpod_handler, "review_renders", lambda *_args, **_kwargs: next(reviews))
    monkeypatch.setattr(runpod_handler, "_upload", lambda *_args, **_kwargs: None)
    rendered = runpod_handler.handler({"input": {
        "jobType": "render",
        "sourceUrl": "https://safe.test/source",
        "clips": [{"id": "clip"}],
        "captions": [{"clipId": "clip", "ass": "ass", "srt": "srt"}],
        "options": {"visualQaEnabled": True, "costRemainingUsd": 1},
        "clipIndexes": [0],
        "outputs": [None, {"ready": True}, {
            "clipIndex": 0,
            "clipId": "clip",
            "exportId": "export",
            "uploadUrl": "https://safe.test/upload",
            "bucket": "videos",
            "key": "exports/clip.mp4",
        }],
    }})
    assert render_calls == [["clip"], ["clip"]]
    assert rendered["quality"]["status"] == "passed"
    assert rendered["quality"]["rerendered"] == ["clip"]
    assert rendered["storage"][0]["sha256"] == hashlib.sha256(b"render").hexdigest()
    assert len(rendered["providerUsage"]) == 2


def test_runpod_handler_output_contract_failures(monkeypatch):
    settings = SimpleNamespace(max_download_bytes=100, runpod_cost_usd_per_second=0.001)
    monkeypatch.setattr(runpod_handler, "Settings", SimpleNamespace(from_env=lambda: settings))

    def download(_url, destination, _maximum):
        destination.write_bytes(b"source")
        return destination

    monkeypatch.setattr(runpod_handler, "_download", download)
    monkeypatch.setattr(runpod_handler, "review_renders", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(runpod_handler, "build_compositions", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(runpod_handler, "render_clips", lambda *_args, **_kwargs: [])
    with pytest.raises(WorkerError) as mismatch:
        runpod_handler.handler({"input": {
            "jobType": "render", "sourceUrl": "https://safe.test/source",
            "clips": [], "options": {"visualQaEnabled": False},
            "outputs": [{"clipIndex": 0, "uploadUrl": "https://safe.test/upload"}],
        }})
    assert mismatch.value.code == "RUNPOD_OUTPUT_MISMATCH"

    def render(_source, _clips, _captions, output_dir, _settings, _options):
        path = output_dir / "clip.mp4"
        output_dir.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"render")
        return [{"clipId": "clip", "path": str(path), "durationSeconds": 1}]

    monkeypatch.setattr(runpod_handler, "render_clips", render)
    with pytest.raises(WorkerError) as upload_url:
        runpod_handler.handler({"input": {
            "jobType": "render", "sourceUrl": "https://safe.test/source",
            "clips": [{"id": "clip"}], "options": {"visualQaEnabled": False},
            "outputs": [{"clipIndex": 0}],
        }})
    assert upload_url.value.code == "RUNPOD_UPLOAD_URL_MISSING"
