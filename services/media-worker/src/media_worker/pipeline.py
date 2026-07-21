import json
import mimetypes
from pathlib import Path
from typing import Any, Callable, Dict, List

from .captions import build_caption_files, caption_style, normalize_cues, render_ass, render_srt
from .clips import find_clips
from .composition import build_compositions, fallback_plan
from .config import Settings
from .deepgram import transcribe_url as transcribe_with_deepgram
from .errors import WorkerError
from .media import (
    detect_burned_in_subtitles,
    extract_frame_thumbnail,
    extract_thumbnail,
    materialize_source,
    materialize_storage,
    probe_media,
)
from .models import ArtifactDescriptor, ArtifactLocation, PipelineRequest, ReframeRequest, StageResponse
from .rendering import render_clips
from .quality import conservative_compositions, review_renders
from .runpod import execute_remote_job
from .scoring import score_all
from .segmentation import semantic_segments
from .storage import upload_file
from .transcription import transcribe
from .vision import analyze_focus, render_reframes, smart_crop_geometry
from .workspace import Workspace, artifact


STAGES = (
    "ingestion",
    "transcription",
    "segmentation",
    "scoring",
    "clips",
    "captions",
    "composition",
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
            "composition": self._composition,
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
                stage, response.model_dump(mode="json", by_alias=True, exclude_none=True)
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
                stage, response.model_dump(mode="json", by_alias=True, exclude_none=True)
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
        metadata["burnedInSubtitles"] = (
            {"detected": False, "confidence": 0.0, "evidence": [], "skipped": "hybrid-light-ingestion"}
            if self.settings.ai_execution_mode == "hybrid"
            else detect_burned_in_subtitles(
                source,
                workspace.path("media"),
                self.settings,
                float(metadata["durationSeconds"]),
            )
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
        provider_error = None
        value = None
        if (
            self.settings.ai_execution_mode == "hybrid"
            and self.settings.stt_provider == "deepgram"
            and request.source_uri
            and _external_budget_available(request.options, self.settings.deepgram_cost_usd_per_hour)
        ):
            try:
                value = transcribe_with_deepgram(
                    request.source_uri, self.settings, request.options
                )
            except WorkerError as error:
                provider_error = error.code
        if value is None:
            source = self._ensure_source(request, workspace)
            value = transcribe(source, self.settings, request.options)
            if provider_error:
                value["fallback"] = {
                    "provider": "deepgram",
                    "reason": provider_error,
                    "engine": "whisperx",
                }
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
                "engine": value.get("engine", "whisperx"),
                "providerUsage": value.get("providerUsage", []),
                "fallback": value.get("fallback"),
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
        llm_settings = (
            self.settings
            if _external_budget_available(request.options, 0.05)
            else None
        )
        value = score_all(segments, llm_settings)
        path = workspace.write_json("scoring/scores.json", value)
        return self._response(
            request,
            "scoring",
            [artifact(path, "viral-scores", "application/json")],
            {
                "segments": len(value["scores"]),
                "averageScore": value["averageScore"],
                "providerUsage": value.get("providerUsage", []),
            },
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
        source_workspace = self._source_workspace(request, workspace)
        remote_gpu = _remote_gpu_enabled(request, self.settings)
        source = None if remote_gpu else self._ensure_source(request, source_workspace)
        clips = source_workspace.read_json("clips/clips.json")["clips"]
        selected_indexes = self._selected_clip_indexes(request, len(clips))
        selected_clips = [clips[index] for index in selected_indexes]
        batch_outputs = request.options.get("batchOutputs")
        if isinstance(batch_outputs, list):
            pending_indexes = {
                int(value.get("clipIndex", -1))
                for value in batch_outputs
                if isinstance(value, dict) and not bool(value.get("ready"))
            }
            pending = [
                (index, clip)
                for index, clip in zip(selected_indexes, selected_clips)
                if index in pending_indexes
            ]
            selected_indexes = [value[0] for value in pending]
            selected_clips = [value[1] for value in pending]
            if not selected_clips:
                manifest = workspace.write_json(
                    "renders/manifest.json", {"renders": [], "captions": [], "storage": []}
                )
                return self._response(
                    request,
                    "rendering",
                    [artifact(manifest, "renders-manifest", "application/json")],
                    {"clips": 0, "storage": [], "reused": len(batch_outputs)},
                )
        caption_time_offset = 0.0
        clip_override = request.options.get("clipOverride")
        if isinstance(clip_override, dict):
            override_index = int(clip_override.get("clipIndex", -1))
            if len(selected_indexes) != 1 or override_index != selected_indexes[0]:
                raise WorkerError("INVALID_CLIP_OVERRIDE", "Clip timing override does not match the selected clip")
            start = float(clip_override.get("start", -1))
            end = float(clip_override.get("end", -1))
            if start < 0 or end <= start:
                raise WorkerError("INVALID_CLIP_OVERRIDE", "Clip timing override is invalid")
            caption_time_offset = float(selected_clips[0]["start"]) - start
            selected_clips = [{**selected_clips[0], "start": start, "end": end}]
        selected_clip_ids = {str(clip["id"]) for clip in selected_clips}
        captions = [
            caption
            for caption in source_workspace.read_json("captions/manifest.json")["captions"]
            if str(caption.get("clipId")) in selected_clip_ids
        ]
        caption_override = request.options.get("captionOverride")
        if isinstance(caption_override, dict) and len(selected_clips) == 1:
            clip = selected_clips[0]
            duration = float(clip["end"]) - float(clip["start"])
            cues = normalize_cues(caption_override.get("cues"), duration, caption_time_offset)
            captions = []
            if cues:
                override_dir = workspace.path("captions")
                override_dir.mkdir(parents=True, exist_ok=True)
                srt_path = override_dir / (str(clip["id"]) + ".srt")
                ass_path = override_dir / (str(clip["id"]) + ".ass")
                template_name = str(caption_override.get("template") or "podcast")
                overrides = caption_override.get("style") if isinstance(caption_override.get("style"), dict) else {}
                srt_path.write_text(render_srt(cues), encoding="utf-8")
                ass_path.write_text(
                    render_ass(cues, caption_style(template_name, overrides), template_name),
                    encoding="utf-8",
                )
                captions = [{
                    "clipId": clip["id"],
                    "srt": str(srt_path),
                    "ass": str(ass_path),
                    "cueCount": len(cues),
                    "cues": cues,
                }]
        render_options = dict(request.options)
        composition_enabled = bool(request.options.get("compositionV1", False))
        composition_plans = []
        generated_composition_path = None
        if composition_enabled:
            composition_path = source_workspace.path("composition/manifest.json")
            if composition_path.is_file():
                composition_plans = source_workspace.read_json("composition/manifest.json").get("compositions", [])
            selected_plan_ids = {str(clip["id"]) for clip in selected_clips}
            regenerate = bool(request.options.get("regenerateComposition", False))
            reusable_plans = [
                plan
                for plan in composition_plans
                if str(plan.get("clipId")) not in selected_plan_ids
                or (
                    not regenerate
                    and str(plan.get("accelerator", "legacy"))
                    == self.settings.media_accelerator
                )
            ]
            reusable_ids = {str(plan.get("clipId")) for plan in reusable_plans}
            missing_clips = [
                clip for clip in selected_clips if str(clip["id"]) not in reusable_ids
            ]
            if missing_clips and not remote_gpu:
                assert source is not None
                generated = build_compositions(
                    source,
                    missing_clips,
                    self.settings,
                    {
                        **request.options,
                        "enabled": True,
                        "voiceActivity": _voice_activity(source_workspace),
                        **_source_video_dimensions(source_workspace),
                    },
                )
                composition_plans = [*reusable_plans, *generated]
                generated_composition_path = source_workspace.write_json(
                    "composition/manifest.json", {"compositions": composition_plans}
                )
            render_options["compositionPlans"] = {
                str(plan["clipId"]): plan
                for plan in composition_plans
                if str(plan.get("clipId")) in selected_plan_ids
            }
        if bool(request.options.get("smartReframe", False)) and not composition_enabled and not remote_gpu:
            assert source is not None
            aspect = str(request.options.get("aspectRatio", "9:16"))
            if aspect not in {"9:16", "1:1", "4:5", "16:9"}:
                raise WorkerError(
                    "INVALID_ASPECT_RATIO", "Unsupported smart reframe aspect ratio"
                )
            smart_crops = {}
            for clip in selected_clips:
                start, end = float(clip["start"]), float(clip["end"])
                analysis_key = "vision/focus-%s-%d-%d.json" % (
                    str(clip["id"]),
                    round(start * 1000),
                    round(end * 1000),
                )
                analysis_path = source_workspace.path(analysis_key)
                if analysis_path.is_file():
                    analysis = source_workspace.read_json(analysis_key)
                else:
                    analysis = analyze_focus(
                        source,
                        str(request.options.get("detector", "auto")),
                        self.settings,
                        start_seconds=start,
                        end_seconds=end,
                    )
                    source_workspace.write_json(analysis_key, analysis)
                smart_crops[str(clip["id"])] = smart_crop_geometry(
                    analysis,
                    aspect,
                    max(
                        360,
                        min(
                            2160,
                            int(
                                request.options.get(
                                    "maxSourceShortSide",
                                    self.settings.render_max_source_short_side,
                                )
                            ),
                        ),
                    ),
                    preserve_source_quality=bool(
                        request.options.get("preserveSourceQuality", False)
                    ),
                )
            render_options["smartCrops"] = smart_crops
        remote_error = None
        remote_provider_usage = []
        if remote_gpu:
            try:
                remote = execute_remote_job(
                    workspace,
                    "rendering",
                    {
                        "jobType": "render",
                        "idempotencyKey": request.stage_execution_id,
                        "sourceUrl": request.source_uri,
                        "sourceSha256": request.options.get("sourceSha256"),
                        "sourceEtag": request.options.get("sourceEtag"),
                        "clips": selected_clips,
                        "captions": _remote_caption_payload(captions),
                        "compositionPlans": render_options.get("compositionPlans", {}),
                        "clipIndexes": selected_indexes,
                        "options": {
                            **request.options,
                            "voiceActivity": _voice_activity(source_workspace),
                            **_source_video_dimensions(source_workspace),
                        },
                        "outputs": request.options.get("batchOutputs", []),
                    },
                    self.settings,
                )
                outputs = remote.get("renders")
                stored = remote.get("storage")
                if not isinstance(outputs, list) or not isinstance(stored, list):
                    raise WorkerError(
                        "RUNPOD_RESPONSE_INVALID",
                        "Runpod render output is missing renders or storage",
                        status_code=502,
                    )
                manifest = workspace.write_json(
                    "renders/manifest.json",
                    {"renders": outputs, "captions": captions, "storage": stored},
                )
                artifacts = [artifact(manifest, "renders-manifest", "application/json")]
                remote_compositions = remote.get("compositions")
                if isinstance(remote_compositions, list):
                    generated_composition_path = source_workspace.write_json(
                        "composition/manifest.json",
                        {"compositions": remote_compositions},
                    )
                    artifacts.append(
                        artifact(
                            generated_composition_path,
                            "composition-manifest",
                            "application/json",
                        )
                    )
                for value in stored:
                    if not isinstance(value, dict) or str(value.get("mediaType")) != "video/mp4":
                        continue
                    artifacts.append(
                        ArtifactDescriptor(
                            kind="rendered-clip",
                            location=ArtifactLocation(
                                type="object",
                                bucket=str(value.get("bucket") or ""),
                                key=str(value.get("key") or ""),
                            ),
                            sha256=str(value.get("sha256") or ""),
                            bytes=int(value.get("bytes") or 0),
                            media_type="video/mp4",
                        )
                    )
                return self._response(
                    request,
                    "rendering",
                    artifacts,
                    {
                        "clips": len(outputs),
                        "storage": stored,
                        "providerUsage": remote.get("providerUsage", []),
                        "quality": remote.get("quality"),
                        "remote": True,
                    },
                )
            except WorkerError as error:
                remote_error = error.code
                remote_provider_usage = (
                    list(error.detail.get("providerUsage", []))
                    if isinstance(error.detail, dict)
                    else []
                )
                source = self._ensure_source(request, source_workspace)
                if composition_enabled:
                    generated = build_compositions(
                        source,
                        selected_clips,
                        self.settings,
                        {
                            **request.options,
                            "enabled": True,
                            "voiceActivity": _voice_activity(source_workspace),
                            **_source_video_dimensions(source_workspace),
                        },
                    )
                    render_options["compositionPlans"] = {
                        str(plan["clipId"]): plan for plan in generated
                    }
                    generated_composition_path = source_workspace.write_json(
                        "composition/manifest.json", {"compositions": generated}
                    )
        assert source is not None
        outputs = render_clips(
            source,
            selected_clips,
            captions,
            workspace.path("renders"),
            self.settings,
            render_options,
        )
        quality = review_renders(
            outputs,
            self.settings,
            workspace.path("quality/contact-sheets"),
            cost_remaining_usd=_optional_float(request.options.get("costRemainingUsd")),
        ) if request.options.get("visualQaEnabled", True) else None
        provider_usage = list(remote_provider_usage)
        if quality:
            provider_usage.extend(quality.get("providerUsage", []))
        if quality and quality.get("failedClipIds") and isinstance(render_options.get("compositionPlans"), dict):
            failed_ids = set(str(value) for value in quality["failedClipIds"])
            failed_clips = [clip for clip in selected_clips if str(clip.get("id")) in failed_ids]
            conservative_plans = conservative_compositions(
                render_options["compositionPlans"], list(failed_ids)
            )
            render_options["compositionPlans"] = conservative_plans
            persisted_plans = {
                str(plan.get("clipId")): plan
                for plan in composition_plans
                if isinstance(plan, dict) and plan.get("clipId")
            }
            persisted_plans.update(conservative_plans)
            generated_composition_path = source_workspace.write_json(
                "composition/manifest.json",
                {"compositions": list(persisted_plans.values())},
            )
            render_clips(
                source,
                failed_clips,
                captions,
                workspace.path("renders"),
                self.settings,
                render_options,
            )
            second_quality = review_renders(
                [value for value in outputs if str(value.get("clipId")) in failed_ids],
                self.settings,
                workspace.path("quality/contact-sheets-rerender"),
                cost_remaining_usd=_remaining_after_usage(
                    request.options.get("costRemainingUsd"), provider_usage
                ),
            )
            if second_quality:
                provider_usage.extend(second_quality.get("providerUsage", []))
                quality = {
                    **second_quality,
                    "rerendered": sorted(failed_ids),
                    "status": "review" if second_quality.get("failedClipIds") else "passed",
                }
        manifest = workspace.write_json("renders/manifest.json", {"renders": outputs, "captions": captions})
        artifacts = [artifact(manifest, "renders-manifest", "application/json")]
        artifacts.extend(
            artifact(Path(output["path"]), "rendered-clip", "video/mp4")
            for output in outputs
        )
        if generated_composition_path is not None:
            artifacts.append(
                artifact(
                    generated_composition_path,
                    "composition-manifest",
                    "application/json",
                )
            )
        return self._response(
            request,
            "rendering",
            artifacts,
            {
                "clips": len(outputs),
                "remote": False,
                "fallback": (
                    {"provider": "runpod", "reason": remote_error}
                    if remote_error
                    else None
                ),
                "quality": quality,
                "providerUsage": provider_usage,
            },
        )

    def _composition(
        self, request: PipelineRequest, workspace: Workspace
    ) -> StageResponse:
        clips = workspace.read_json("clips/clips.json")["clips"]
        composition_options = {
            **request.options,
            "voiceActivity": _voice_activity(workspace),
            **_source_video_dimensions(workspace),
        }
        deferred = (
            self.settings.ai_execution_mode == "hybrid"
            and self.settings.gpu_provider == "runpod"
            and bool(request.options.get("remote"))
        )
        if deferred:
            aspect = str(request.options.get("aspectRatio", "9:16"))
            plans = [fallback_plan(clip, aspect, "deferred-runpod") for clip in clips]
            for plan in plans:
                plan["source"] = {
                    "width": int(composition_options.get("sourceWidth", 0)),
                    "height": int(composition_options.get("sourceHeight", 0)),
                }
                plan["accelerator"] = "deferred"
                plan["diagnostics"]["accelerator"] = "deferred"
        else:
            source = self._ensure_source(request, workspace)
            plans = build_compositions(source, clips, self.settings, composition_options)
        manifest = workspace.write_json(
            "composition/manifest.json", {"compositions": plans}
        )
        ready = sum(
            1
            for plan in plans
            if plan.get("diagnostics", {}).get("status") == "ready"
        )
        fallbacks = len(plans) - ready
        return self._response(
            request,
            "composition",
            [artifact(manifest, "composition-manifest", "application/json")],
            {
                "clips": len(plans),
                "ready": ready,
                "fallbacks": fallbacks,
                "version": plans[0]["version"] if plans else "composition-v1",
                "providerUsage": [],
                "remote": False,
                "deferred": deferred,
            },
        )

    def _exports(self, request: PipelineRequest, workspace: Workspace) -> StageResponse:
        source_workspace = self._source_workspace(request, workspace)
        render_manifest = workspace.read_json("renders/manifest.json")
        renders = render_manifest["renders"]
        clips = source_workspace.read_json("clips/clips.json")["clips"]
        selected_indexes = self._selected_clip_indexes(request, len(clips))
        selected_clip_ids = {str(clips[index]["id"]) for index in selected_indexes}
        captions = (
            render_manifest["captions"]
            if "captions" in render_manifest
            else [
                caption
                for caption in source_workspace.read_json("captions/manifest.json")["captions"]
                if str(caption.get("clipId")) in selected_clip_ids
            ]
        )
        bucket = str(
            request.options.get("bucket")
            or (request.storage.bucket if request.storage else "")
        )
        prefix = str(
            request.options.get("prefix", "exports/%s" % request.video_id)
        ).strip("/")
        purpose = str(request.options.get("purpose", "FINAL"))
        batch_outputs = request.options.get("batchOutputs")
        batch_outputs = batch_outputs if isinstance(batch_outputs, list) else []
        is_batch = bool(request.options.get("batch", False))
        files: List[Path] = []
        uploaded = [
            dict(value)
            for value in render_manifest.get("storage", [])
            if isinstance(value, dict)
        ]
        renders_by_id = {
            str(value.get("clipId")): value
            for value in renders
            if isinstance(value, dict)
        }
        captions_by_id = {
            str(value.get("clipId")): value
            for value in captions
            if isinstance(value, dict)
        }
        if is_batch:
            for spec in batch_outputs:
                if not isinstance(spec, dict):
                    continue
                clip_index = int(spec.get("clipIndex", -1))
                if clip_index < 0 or clip_index >= len(clips):
                    continue
                source_clip_id = str(clips[clip_index]["id"])
                export_id = str(spec.get("exportId") or "")
                clip_id = str(spec.get("clipId") or "")
                already_uploaded = any(
                    str(value.get("exportId")) == export_id
                    and str(value.get("mediaType")) == "video/mp4"
                    for value in uploaded
                )
                rendered = renders_by_id.get(source_clip_id)
                if not bool(spec.get("ready")) and not already_uploaded and rendered and rendered.get("path"):
                    path = Path(str(rendered["path"]))
                    files.append(path)
                    stored = upload_file(path, bucket, str(spec.get("key") or ""), self.settings)
                    uploaded.append({**stored, "clipId": clip_id, "exportId": export_id, "clipIndex": clip_index})
                caption = captions_by_id.get(source_clip_id)
                if purpose == "FINAL" and caption:
                    output_prefix = str(spec.get("prefix") or str(spec.get("key") or "").rsplit("/", 1)[0]).strip("/")
                    for kind in ("srt", "ass"):
                        path = Path(str(caption.get(kind) or ""))
                        if not path.is_file():
                            continue
                        files.append(path)
                        stored = upload_file(path, bucket, "%s/%s" % (output_prefix, path.name), self.settings)
                        uploaded.append({**stored, "clipId": clip_id, "exportId": export_id, "clipIndex": clip_index})
        else:
            files.extend(
                Path(str(value["path"]))
                for value in renders
                if str(value.get("clipId")) in selected_clip_ids and value.get("path")
            )
            if purpose == "FINAL":
                files.extend(
                    Path(str(value[kind]))
                    for value in captions
                    for kind in ("srt", "ass")
                    if value.get(kind)
                )
            if bucket:
                existing_keys = {str(value.get("key")) for value in uploaded}
                for path in files:
                    key = "%s/%s" % (prefix, path.name)
                    if key not in existing_keys:
                        uploaded.append(upload_file(path, bucket, key, self.settings))
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

    def _source_workspace(self, request: PipelineRequest, workspace: Workspace) -> Workspace:
        source_pipeline_run_id = str(
            request.options.get("sourcePipelineRunId") or request.pipeline_run_id
        )
        if source_pipeline_run_id == request.pipeline_run_id:
            return workspace
        source_root = (self.settings.data_dir / source_pipeline_run_id).resolve()
        if not source_root.exists():
            raise WorkerError(
                "RENDER_SOURCE_WORKSPACE_MISSING",
                "The completed source pipeline workspace is not available for on-demand rendering",
                status_code=409,
                detail={"sourcePipelineRunId": source_pipeline_run_id},
            )
        return Workspace(self.settings.data_dir, source_pipeline_run_id)

    def _selected_clip_indexes(self, request: PipelineRequest, clip_count: int) -> List[int]:
        if "clipIndexes" in request.options and isinstance(request.options["clipIndexes"], list):
            indexes = [int(value) for value in request.options["clipIndexes"]]
        elif "clipIndex" in request.options:
            indexes = [int(request.options["clipIndex"])]
        elif self.settings.allow_full_batch_render:
            indexes = list(range(clip_count))
        else:
            raise WorkerError(
                "FULL_BATCH_RENDER_DISABLED",
                "Rendering requires a selected clip; full batch rendering is disabled",
                status_code=409,
            )
        unique = sorted(set(indexes))
        if not unique or any(index < 0 or index >= clip_count for index in unique):
            raise WorkerError(
                "INVALID_RENDER_CLIP_INDEX",
                "The requested clip index is not available for rendering",
                status_code=422,
                detail={"clipCount": clip_count, "clipIndexes": unique},
            )
        return unique

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
            schemaVersion=(
                2
                if any(
                    value.location is not None and value.location.type == "object"
                    for value in artifacts
                )
                else 1
            ),
            pipelineRunId=request.pipeline_run_id,
            stageExecutionId=request.stage_execution_id,
            videoId=request.video_id,
            stage=stage,
            artifacts=artifacts,
            metrics=metrics,
        )


def _media_type(path: Path) -> str:
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _external_budget_available(options: Dict[str, Any], estimated_usd_per_hour: float) -> bool:
    remaining = options.get("costRemainingUsd")
    source_duration = options.get("sourceDurationSeconds")
    if remaining is None or source_duration is None:
        return True
    estimated = max(0.0, float(source_duration)) / 3600.0 * max(0.0, estimated_usd_per_hour)
    return estimated <= max(0.0, float(remaining))


def _remote_gpu_enabled(request: PipelineRequest, settings: Settings) -> bool:
    if not (
        settings.ai_execution_mode == "hybrid"
        and settings.gpu_provider == "runpod"
        and bool(request.options.get("remote"))
        and request.source_uri
    ):
        return False
    remaining = request.options.get("costRemainingUsd")
    source_duration = request.options.get("sourceDurationSeconds")
    if remaining is None or source_duration is None:
        return True
    # The first production guard assumes GPU time may reach half of source duration.
    # Actual provider usage is persisted and subsequent stages consume the remainder.
    estimated_gpu_seconds = max(30.0, float(source_duration) * 0.5)
    estimated_cost = estimated_gpu_seconds * settings.runpod_cost_usd_per_second
    return estimated_cost <= max(0.0, float(remaining))


def _remote_caption_payload(captions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    values = []
    for caption in captions:
        if not isinstance(caption, dict):
            continue
        ass_path = Path(str(caption.get("ass") or ""))
        srt_path = Path(str(caption.get("srt") or ""))
        if not ass_path.is_file():
            continue
        values.append(
            {
                "clipId": str(caption.get("clipId") or ""),
                "ass": ass_path.read_text(encoding="utf-8"),
                "srt": srt_path.read_text(encoding="utf-8") if srt_path.is_file() else "",
                "cueCount": int(caption.get("cueCount") or 0),
            }
        )
    return values


def _optional_float(value: Any) -> Any:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _remaining_after_usage(value: Any, usage: List[Dict[str, Any]]) -> Any:
    remaining = _optional_float(value)
    if remaining is None:
        return None
    spent = sum(max(0.0, float(item.get("costUsd") or 0.0)) for item in usage)
    return max(0.0, remaining - spent)


def _voice_activity(workspace: Workspace) -> List[Dict[str, Any]]:
    transcript_path = workspace.path("transcription/transcript.json")
    if not transcript_path.is_file():
        return []
    try:
        segments = workspace.read_json("transcription/transcript.json").get("segments", [])
    except (OSError, ValueError, TypeError):
        return []
    return [
        {
            "start": segment.get("start", 0),
            "end": segment.get("end", 0),
            "speaker": segment.get("speaker"),
        }
        for segment in segments
        if isinstance(segment, dict)
    ]


def _source_video_dimensions(workspace: Workspace) -> Dict[str, int]:
    metadata_path = workspace.path("media/metadata.json")
    if not metadata_path.is_file():
        return {}
    try:
        video = workspace.read_json("media/metadata.json").get("video", {})
        width, height = int(video.get("width", 0)), int(video.get("height", 0))
    except (OSError, ValueError, TypeError, AttributeError):
        return {}
    return {
        "sourceWidth": width,
        "sourceHeight": height,
    } if width > 0 and height > 0 else {}


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
