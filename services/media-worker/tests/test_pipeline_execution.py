from dataclasses import replace
from pathlib import Path

import pytest

from media_worker.config import Settings
from media_worker.errors import WorkerError
from media_worker.models import PipelineRequest, ReframeRequest
from media_worker.pipeline import Pipeline


def request(stage_id="stage-123"):
    return PipelineRequest.model_validate(
        {
            "pipelineRunId": "pipeline-123",
            "stageExecutionId": stage_id,
            "videoId": "video-123",
            "sourceUri": "file:///source.mp4",
        }
    )


def test_pipeline_executes_every_stage_and_reframe(tmp_path, monkeypatch):
    import media_worker.pipeline as module

    settings = replace(
        Settings.from_env(),
        data_dir=tmp_path,
        s3_bucket="clipbr-videos",
        s3_endpoint_url="http://storage",
        s3_access_key_id="access",
        s3_secret_access_key="secret",
        allow_full_batch_render=True,
    )
    pipeline = Pipeline(settings)

    def materialize(_uri, target, _settings):
        target.mkdir(parents=True, exist_ok=True)
        path = target / "source.mp4"
        path.write_bytes(b"video")
        return path

    def captions(_transcript, clips, output, **_options):
        output.mkdir(parents=True, exist_ok=True)
        values = []
        for clip in clips:
            srt, ass = output / (clip["id"] + ".srt"), output / (clip["id"] + ".ass")
            srt.write_text("caption")
            ass.write_text("caption")
            values.append({"clipId": clip["id"], "srt": str(srt), "ass": str(ass), "cueCount": 1})
        return values

    def renders(_source, clips, _captions, output, _settings, _options):
        output.mkdir(parents=True, exist_ok=True)
        values = []
        for clip in clips:
            path = output / (clip["id"] + ".mp4")
            path.write_bytes(b"render")
            values.append({"clipId": clip["id"], "path": str(path), "durationSeconds": 20})
        return values

    def reframes(source, _analysis, aspects, output, _settings):
        output.mkdir(parents=True, exist_ok=True)
        values = []
        for aspect in aspects:
            path = output / ("reframe-" + aspect.replace(":", "x") + ".mp4")
            path.write_bytes(source.read_bytes())
            values.append(path)
        return values

    def thumbnail(_source, output, _settings, _duration_seconds):
        output.mkdir(parents=True, exist_ok=True)
        path = output / "thumbnail.jpg"
        path.write_bytes(b"thumbnail")
        return path

    def clip_thumbnail(_source, output, _settings, _at_seconds, stem):
        output.mkdir(parents=True, exist_ok=True)
        path = output / (stem + ".jpg")
        path.write_bytes(b"clip-thumbnail")
        return path

    monkeypatch.setattr(module, "materialize_source", materialize)
    monkeypatch.setattr(module, "probe_media", lambda *_: {"durationSeconds": 20, "video": {"width": 640, "height": 360}})
    monkeypatch.setattr(module, "extract_thumbnail", thumbnail)
    monkeypatch.setattr(module, "extract_frame_thumbnail", clip_thumbnail)
    monkeypatch.setattr(module, "detect_burned_in_subtitles", lambda *_: {"detected": False, "confidence": 0, "evidence": []})
    monkeypatch.setattr(module, "transcribe", lambda *_: {"language": "en", "confidence": 0.9, "speakerCount": 0, "durationSeconds": 20, "segments": [{"id": 0, "start": 0, "end": 20, "text": "useful segment", "speaker": None, "words": [{"word": "useful", "start": 0, "end": 1}]}]})
    monkeypatch.setattr(module, "semantic_segments", lambda *_args, **_kwargs: [{"id": 0, "start": 0, "end": 20, "text": "useful segment"}])
    monkeypatch.setattr(module, "score_all", lambda segments, *_args, **_kwargs: {"scores": [{"segmentId": 0, "score": 90}], "averageScore": 90})
    monkeypatch.setattr(module, "find_clips", lambda *_args, **_kwargs: [{"id": "clip-001", "start": 0, "end": 20, "score": 90, "text": "useful segment"}])
    monkeypatch.setattr(module, "build_caption_files", captions)
    monkeypatch.setattr(module, "analyze_focus", lambda *_args, **_kwargs: {"backend": "opencv", "detectionRate": 0, "width": 640, "height": 360, "focus": {"x": 320, "y": 180}})
    monkeypatch.setattr(module, "render_reframes", reframes)
    monkeypatch.setattr(module, "render_clips", renders)
    monkeypatch.setattr(module, "upload_file", lambda path, bucket, key, _settings: {"bucket": bucket, "key": key, "bytes": path.stat().st_size, "mediaType": "video/mp4"})

    for stage in module.STAGES:
        response = pipeline.execute(stage, request("stage-" + stage))
        assert response.status == "succeeded"
        assert response.stage == stage

    cached = pipeline.execute("exports", request("stage-cached"))
    assert cached.cached is True

    reframe_request = ReframeRequest.model_validate(
        {
            "pipelineRunId": "pipeline-123",
            "stageExecutionId": "reframe-123",
            "videoId": "video-123",
            "sourceUri": "file:///source.mp4",
            "aspectRatios": ["9:16", "1:1"],
        }
    )
    reframed = pipeline.reframe(reframe_request)
    assert reframed.metrics["outputs"] == 2
    assert pipeline.reframe(reframe_request).cached is True
    with pytest.raises(Exception, match="Unsupported pipeline"):
        pipeline.execute("unknown", request())


def test_rendering_rejects_invalid_aspect_ratio(tmp_path, monkeypatch):
    import media_worker.pipeline as module

    pipeline = Pipeline(replace(Settings.from_env(), data_dir=tmp_path))
    workspace = tmp_path / "pipeline-123" / "media"
    workspace.mkdir(parents=True)
    (workspace / "source.mp4").write_bytes(b"video")
    (tmp_path / "pipeline-123" / "clips").mkdir()
    (tmp_path / "pipeline-123" / "clips" / "clips.json").write_text('{"clips": [{"id": "clip-001", "start": 0, "end": 5}]}')
    (tmp_path / "pipeline-123" / "captions").mkdir()
    (tmp_path / "pipeline-123" / "captions" / "manifest.json").write_text('{"captions": []}')
    body = request()
    body.options = {"smartReframe": True, "aspectRatio": "2:3", "clipIndex": 0}
    with pytest.raises(Exception, match="Unsupported smart reframe"):
        pipeline.execute("rendering", body)


def test_rendering_requires_selected_clip_by_default(tmp_path):
    pipeline = Pipeline(replace(Settings.from_env(), data_dir=tmp_path))
    workspace = tmp_path / "pipeline-123" / "media"
    workspace.mkdir(parents=True)
    (workspace / "source.mp4").write_bytes(b"video")
    (tmp_path / "pipeline-123" / "clips").mkdir()
    (tmp_path / "pipeline-123" / "clips" / "clips.json").write_text('{"clips": [{"id": "clip-001", "start": 0, "end": 5}]}')
    (tmp_path / "pipeline-123" / "captions").mkdir()
    (tmp_path / "pipeline-123" / "captions" / "manifest.json").write_text('{"captions": []}')

    with pytest.raises(WorkerError) as error:
        pipeline.execute("rendering", request())
    assert error.value.code == "FULL_BATCH_RENDER_DISABLED"
