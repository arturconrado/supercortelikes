import json
import mimetypes
from pathlib import Path
from typing import Any, Callable, Dict, List

from .captions import build_caption_files
from .clips import find_clips
from .config import Settings
from .errors import WorkerError
from .media import (
    detect_burned_in_subtitles,
    extract_frame_thumbnail,
    extract_thumbnail,
    materialize_source,
    materialize_storage,
    probe_media,
)
from .models import ArtifactDescriptor, PipelineRequest, ReframeRequest, StageResponse
from .rendering import render_clips
from .scoring import score_all
from .segmentation import semantic_segments
from .storage import upload_file
from .transcription import transcribe
from .vision import analyze_focus, render_reframes
from .workspace import Workspace, artifact


STAGES = (
    "ingestion",
    "transcription",
    "segmentation",
    "scoring",
    "clips",
    "captions",
    "rendering",
    "exports",
)


class Pipeline:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.handlers: Dict[
            str, Callable[[PipelineRequest, Workspace], StageResponse]
        ] = {
            "ingestion": self._ingestion,
            "transcription": self._transcription,
            "segmentation": self._segmentation,
            "scoring": self._scoring,
            "clips": self._clips,
            "captions": self._captions,
            "rendering": self._rendering,
            "exports": self._exports,
        }

    def execute(self, stage: str, request: PipelineRequest) -> StageResponse:
        if stage not in self.handlers:
            raise WorkerError(
                "UNKNOWN_STAGE",
                "Unsupported pipeline stage: %s" % stage,
                status_code=404,
            )
        workspace = Workspace(self.settings.data_dir, request.pipeline_run_id)
        with workspace.stage_lock(stage):
            if workspace.has_result(stage) and not request.force:
                cached = workspace.load_result(stage)
                cached["cached"] = True
                cached["stageExecutionId"] = request.stage_execution_id
                return StageResponse.model_validate(cached)
            response = self.handlers[stage](request, workspace)
            workspace.save_result(
                stage, response.model_dump(mode="json", by_alias=True)
            )
            return response

    def reframe(self, request: ReframeRequest) -> StageResponse:
        workspace = Workspace(self.settings.data_dir, request.pipeline_run_id)
        stage = "reframe"
        with workspace.stage_lock(stage):
            if workspace.has_result(stage) and not request.force:
                cached = workspace.load_result(stage)
                cached["cached"] = True
                cached["stageExecutionId"] = request.stage_execution_id
                return StageResponse.model_validate(cached)
            source = self._ensure_source(request, workspace)
            analysis = analyze_focus(
                source,
                request.detector,
                self.settings,
                float(request.options.get("sampleSeconds", 0.75)),
            )
            analysis_path = workspace.write_json("vision/focus.json", analysis)
            outputs = render_reframes(
                source,
                analysis,
                request.aspect_ratios,
                workspace.path("reframes"),
                self.settings,
            )
            artifacts = [artifact(analysis_path, "focus-analysis", "application/json")]
            artifacts.extend(
                artifact(path, "reframed-video", "video/mp4") for path in outputs
            )
            response = self._response(
                request,
                stage,
                artifacts,
                {
                    "backend": analysis["backend"],
                    "detectionRate": analysis["detectionRate"],
                    "outputs": len(outputs),
                },
            )
            workspace.save_result(
                stage, response.model_dump(mode="json", by_alias=True)
            )
            return response

    def _ingestion(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        source = self._ensure_source(request, workspace)
        metadata = probe_media(source, self.settings)
        source_metadata = _read_source_metadata(source)
        if source_metadata:
            metadata["source"] = source_metadata
        thumbnail = extract_thumbnail(
            source,
            workspace.path("media"),
            self.settings,
            float(metadata["durationSeconds"]),
        )
        metadata["burnedInSubtitles"] = detect_burned_in_subtitles(
            source,
            workspace.path("media"),
            self.settings,
            float(metadata["durationSeconds"]),
        )
        metadata["sourcePath"] = str(source)
        metadata_path = workspace.write_json("media/metadata.json", metadata)
        return self._response(
            request,
            "ingestion",
            [
                artifact(source, "source-video", _media_type(source)),
                artifact(thumbnail, "source-thumbnail", "image/jpeg"),
                artifact(metadata_path, "media-metadata", "application/json"),
            ],
            metadata,
        )

    def _transcription(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        source = self._ensure_source(request, workspace)
        value = transcribe(source, self.settings, request.options)
        path = workspace.write_json("transcription/transcript.json", value)
        return self._response(
            request,
            "transcription",
            [artifact(path, "whisperx-transcript", "application/json")],
            {
                "language": value["language"],
                "confidence": value["confidence"],
                "speakerCount": value["speakerCount"],
                "segments": len(value["segments"]),
            },
        )

    def _segmentation(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        transcript = workspace.read_json("transcription/transcript.json")
        segments = semantic_segments(
            transcript["segments"],
            silence_threshold=float(request.options.get("silenceThreshold", 1.2)),
            topic_similarity_threshold=float(
                request.options.get("topicSimilarityThreshold", 0.12)
            ),
            target_duration=float(request.options.get("targetDuration", 28.0)),
            max_duration=float(request.options.get("maxDuration", 55.0)),
        )
        value = {"algorithmVersion": "semantic-rules-v1", "segments": segments}
        path = workspace.write_json("segmentation/segments.json", value)
        return self._response(
            request,
            "segmentation",
            [artifact(path, "semantic-segments", "application/json")],
            {"segments": len(segments)},
        )

    def _scoring(self, request: PipelineRequest, workspace: Workspace) -> StageResponse:
        segments = workspace.read_json("segmentation/segments.json")["segments"]
        value = score_all(segments, self.settings)
        path = workspace.write_json("scoring/scores.json", value)
        return self._response(
            request,
            "scoring",
            [artifact(path, "viral-scores", "application/json")],
            {"segments": len(value["scores"]), "averageScore": value["averageScore"]},
        )

    def _clips(self, request: PipelineRequest, workspace: Workspace) -> StageResponse:
        segments = workspace.read_json("segmentation/segments.json")["segments"]
        scores = workspace.read_json("scoring/scores.json")["scores"]
        clips = find_clips(
            segments,
            scores,
            minimum_duration=float(request.options.get("minimumDuration", 15.0)),
            maximum_duration=float(request.options.get("maximumDuration", 90.0)),
            requested_count=int(request.options.get("count", 20)),
        )
        source = self._ensure_source(request, workspace)
        thumbnail_artifacts: List[ArtifactDescriptor] = []
        for clip in clips:
            thumbnail = extract_frame_thumbnail(
                source,
                workspace.path("clip-thumbnails"),
                self.settings,
                float(clip["start"]),
                str(clip["id"]),
            )
            clip["thumbnail"] = str(thumbnail)
            thumbnail_artifacts.append(artifact(thumbnail, "clip-thumbnail", "image/jpeg"))
        value = {"algorithmVersion": "clip-curator-v1", "clips": clips}
        path = workspace.write_json("clips/clips.json", value)
        return self._response(
            request,
            "clips",
            [artifact(path, "clip-candidates", "application/json"), *thumbnail_artifacts],
            {"clips": len(clips), "topScore": clips[0]["score"] if clips else 0},
        )

    def _captions(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        transcript = workspace.read_json("transcription/transcript.json")
        clips = workspace.read_json("clips/clips.json")["clips"]
        outputs = build_caption_files(
            transcript,
            clips,
            workspace.path("captions"),
            template_name=str(request.options.get("template", "podcast")),
            words_per_cue=int(request.options.get("wordsPerCue", 4)),
        )
        manifest = workspace.write_json("captions/manifest.json", {"captions": outputs})
        artifacts = [artifact(manifest, "captions-manifest", "application/json")]
        for output in outputs:
            artifacts.append(
                artifact(Path(output["srt"]), "captions-srt", "application/x-subrip")
            )
            artifacts.append(
                artifact(Path(output["ass"]), "captions-ass", "text/x-ssa")
            )
        return self._response(
            request,
            "captions",
            artifacts,
            {"clips": len(outputs), "files": len(outputs) * 2},
        )

    def _rendering(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        source = self._ensure_source(request, workspace)
        clips = workspace.read_json("clips/clips.json")["clips"]
        captions = workspace.read_json("captions/manifest.json")["captions"]
        render_source = source
        if bool(request.options.get("smartReframe", False)):
            aspect = str(request.options.get("aspectRatio", "9:16"))
            if aspect not in {"9:16", "1:1", "4:5", "16:9"}:
                raise WorkerError(
                    "INVALID_ASPECT_RATIO", "Unsupported smart reframe aspect ratio"
                )
            analysis = analyze_focus(
                source, str(request.options.get("detector", "auto")), self.settings
            )
            workspace.write_json("vision/focus.json", analysis)
            render_source = render_reframes(
                source, analysis, [aspect], workspace.path("reframes"), self.settings
            )[0]
        outputs = render_clips(
            render_source,
            clips,
            captions,
            workspace.path("renders"),
            self.settings,
            request.options,
        )
        manifest = workspace.write_json("renders/manifest.json", {"renders": outputs})
        artifacts = [artifact(manifest, "renders-manifest", "application/json")]
        artifacts.extend(
            artifact(Path(output["path"]), "rendered-clip", "video/mp4")
            for output in outputs
        )
        return self._response(request, "rendering", artifacts, {"clips": len(outputs)})

    def _exports(self, request: PipelineRequest, workspace: Workspace) -> StageResponse:
        renders = workspace.read_json("renders/manifest.json")["renders"]
        captions = workspace.read_json("captions/manifest.json")["captions"]
        files = [Path(value["path"]) for value in renders]
        files.extend(Path(value[kind]) for value in captions for kind in ("srt", "ass"))
        bucket = str(
            request.options.get("bucket")
            or (request.storage.bucket if request.storage else "")
        )
        prefix = str(
            request.options.get("prefix", "exports/%s" % request.video_id)
        ).strip("/")
        uploaded = []
        if bucket:
            for path in files:
                uploaded.append(
                    upload_file(
                        path, bucket, "%s/%s" % (prefix, path.name), self.settings
                    )
                )
        manifest_value = {
            "files": [
                {
                    "path": str(path),
                    "bytes": path.stat().st_size,
                    "mediaType": _media_type(path),
                }
                for path in files
            ],
            "storage": uploaded,
        }
        manifest = workspace.write_json("exports/manifest.json", manifest_value)
        return self._response(
            request,
            "exports",
            [artifact(manifest, "export-manifest", "application/json")],
            {
                "files": len(files),
                "uploaded": len(uploaded),
                "bucket": bucket or None,
                "storage": uploaded,
            },
        )

    def _ensure_source(self, request: PipelineRequest, workspace: Workspace) -> Path:
        source_dir = workspace.path("media")
        existing = (
            sorted(
                path
                for path in source_dir.glob("source.*")
                if path.is_file()
                and not path.name.endswith(".part")
                and path.suffix.lower() in {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".media"}
            )
            if source_dir.exists()
            else []
        )
        if existing:
            return existing[0]
        if request.storage:
            return materialize_storage(request.storage, source_dir, self.settings)
        if request.source_uri:
            return materialize_source(request.source_uri, source_dir, self.settings)
        raise WorkerError(
            "SOURCE_REQUIRED",
            "storage or sourceUri is required before the source has been ingested",
        )

    @staticmethod
    def _response(
        request: PipelineRequest,
        stage: str,
        artifacts: List[ArtifactDescriptor],
        metrics: Dict[str, Any],
    ) -> StageResponse:
        return StageResponse(
            pipelineRunId=request.pipeline_run_id,
            stageExecutionId=request.stage_execution_id,
            videoId=request.video_id,
            stage=stage,
            artifacts=artifacts,
            metrics=metrics,
        )


def _media_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _read_source_metadata(source: Path) -> Dict[str, Any]:
    metadata_path = source.parent / "source.metadata.json"
    if not metadata_path.is_file():
        return {}
    try:
        value = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(value, dict):
        return {}
    return {
        key: item
        for key, item in value.items()
        if key in {"id", "title", "uploader", "channel", "webpage_url", "duration", "thumbnail"}
        and isinstance(item, (str, int, float))
    }
