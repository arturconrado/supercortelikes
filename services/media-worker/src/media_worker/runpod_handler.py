import hashlib
import http.client
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Mapping

import runpod

from .composition import build_compositions
from .config import Settings
from .errors import WorkerError
from .rendering import render_clips
from .quality import conservative_compositions, review_renders


def handler(job: Mapping[str, Any]) -> Dict[str, Any]:
    payload = job.get("input")
    if not isinstance(payload, Mapping):
        raise WorkerError("RUNPOD_INPUT_INVALID", "Runpod input must be an object")
    started = time.monotonic()
    settings = Settings.from_env()
    job_type = str(payload.get("jobType") or "")
    source_url = str(payload.get("sourceUrl") or "")
    clips = payload.get("clips")
    options = payload.get("options")
    if job_type not in {"composition", "render"}:
        raise WorkerError("RUNPOD_JOB_INVALID", "Unsupported Runpod media job")
    if not isinstance(clips, list) or not isinstance(options, Mapping):
        raise WorkerError("RUNPOD_INPUT_INVALID", "Runpod clips and options are required")

    with tempfile.TemporaryDirectory(prefix="picashorts-runpod-") as temporary:
        root = Path(temporary)
        source = _download(source_url, root / "source.media", settings.max_download_bytes)
        expected_sha256 = str(payload.get("sourceSha256") or "").lower()
        if expected_sha256 and _sha256(source) != expected_sha256:
            raise WorkerError("RUNPOD_SOURCE_CHECKSUM_MISMATCH", "Runpod source checksum does not match")
        render_options = dict(options)
        if render_options.get("analysisFps"):
            render_options["sampleSeconds"] = 1.0 / max(1.0, float(render_options["analysisFps"]))
        watermark_url = str(render_options.pop("watermarkUrl", "") or "")
        render_options.pop("watermarkPath", None)
        if watermark_url:
            render_options["watermarkPath"] = str(
                _download(watermark_url, root / "watermark.png", 8 * 1024 * 1024)
            )
        if job_type == "composition":
            compositions = build_compositions(source, clips, settings, render_options)
            return {
                "compositions": compositions,
                "metrics": _metrics(started, "composition"),
            }

        captions = _materialize_captions(payload.get("captions"), root / "captions")
        plans = payload.get("compositionPlans")
        plan_by_id = dict(plans) if isinstance(plans, Mapping) else {}
        missing = [clip for clip in clips if str(clip.get("id")) not in plan_by_id]
        if missing:
            for plan in build_compositions(
                source,
                missing,
                settings,
                {**render_options, "enabled": True},
            ):
                plan_by_id[str(plan["clipId"])] = plan
        render_options["compositionPlans"] = plan_by_id
        rendered = render_clips(
            source,
            clips,
            captions,
            root / "renders",
            settings,
            render_options,
        )
        qa_budget = _remaining_after_gpu(
            options.get("costRemainingUsd"), started, settings
        )
        quality = review_renders(
            rendered,
            settings,
            root / "quality" / "contact-sheets",
            cost_remaining_usd=qa_budget,
        ) if options.get("visualQaEnabled", True) else None
        provider_usage = [] if not quality else list(quality.get("providerUsage", []))
        if quality and quality.get("failedClipIds"):
            failed_ids = set(str(value) for value in quality["failedClipIds"])
            failed_clips = [clip for clip in clips if str(clip.get("id")) in failed_ids]
            plan_by_id = conservative_compositions(plan_by_id, list(failed_ids))
            render_options["compositionPlans"] = plan_by_id
            render_clips(
                source,
                failed_clips,
                captions,
                root / "renders",
                settings,
                render_options,
            )
            second_quality = review_renders(
                [value for value in rendered if str(value.get("clipId")) in failed_ids],
                settings,
                root / "quality" / "contact-sheets-rerender",
                cost_remaining_usd=_remaining_after_usage(
                    qa_budget, provider_usage
                ),
            )
            if second_quality:
                provider_usage.extend(second_quality.get("providerUsage", []))
                quality = {
                    **second_quality,
                    "rerendered": sorted(failed_ids),
                    "status": "review" if second_quality.get("failedClipIds") else "passed",
                }
        selected_indexes = [int(value) for value in payload.get("clipIndexes", range(len(rendered)))]
        result_by_index = {
            index: value for index, value in zip(selected_indexes, rendered)
        }
        storage = []
        remote_renders = []
        output_specs = payload.get("outputs") if isinstance(payload.get("outputs"), list) else []
        for spec in output_specs:
            if not isinstance(spec, Mapping) or bool(spec.get("ready")):
                continue
            clip_index = int(spec.get("clipIndex", -1))
            value = result_by_index.get(clip_index)
            if not value:
                raise WorkerError("RUNPOD_OUTPUT_MISMATCH", "A requested clip was not rendered")
            path = Path(str(value["path"]))
            upload_url = str(spec.get("uploadUrl") or "")
            if not upload_url:
                raise WorkerError("RUNPOD_UPLOAD_URL_MISSING", "A render upload URL is required")
            checksum = _sha256(path)
            _upload(upload_url, path, "video/mp4")
            stored = {
                "clipIndex": clip_index,
                "clipId": str(spec.get("clipId") or ""),
                "sourceClipId": str(value.get("clipId") or ""),
                "exportId": str(spec.get("exportId") or ""),
                "bucket": str(spec.get("bucket") or ""),
                "key": str(spec.get("key") or ""),
                "bytes": path.stat().st_size,
                "sha256": checksum,
                "mediaType": "video/mp4",
            }
            storage.append(stored)
            remote_renders.append(
                {
                    "clipId": str(value.get("clipId") or ""),
                    "clipIndex": clip_index,
                    "durationSeconds": value.get("durationSeconds"),
                    "bucket": stored["bucket"],
                    "key": stored["key"],
                    "sha256": checksum,
                    "bytes": stored["bytes"],
                }
            )
        return {
            "renders": remote_renders,
            "storage": storage,
            "compositions": list(plan_by_id.values()),
            "quality": quality,
            "providerUsage": provider_usage,
            "metrics": _metrics(started, "render"),
        }


def _download(url: str, destination: Path, maximum_bytes: int) -> Path:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WorkerError("RUNPOD_SOURCE_URL_INVALID", "Runpod source URLs must use HTTPS")
    request = urllib.request.Request(url, headers={"user-agent": "PicaShorts-Runpod/1.0"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with urllib.request.urlopen(request, timeout=120) as response, destination.open("wb") as output:
        content_length = int(response.headers.get("content-length") or 0)
        if content_length > maximum_bytes:
            raise WorkerError("RUNPOD_SOURCE_TOO_LARGE", "Runpod source exceeds the configured limit")
        while True:
            block = response.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > maximum_bytes:
                raise WorkerError("RUNPOD_SOURCE_TOO_LARGE", "Runpod source exceeds the configured limit")
            output.write(block)
    if total == 0:
        raise WorkerError("RUNPOD_SOURCE_EMPTY", "Runpod downloaded an empty source")
    return destination


def _upload(url: str, path: Path, media_type: str) -> None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise WorkerError("RUNPOD_UPLOAD_URL_INVALID", "Runpod upload URLs must use HTTPS")
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=300)
    target = parsed.path + (("?" + parsed.query) if parsed.query else "")
    try:
        with path.open("rb") as body:
            connection.request(
                "PUT",
                target,
                body=body,
                headers={
                    "content-type": media_type,
                    "content-length": str(path.stat().st_size),
                },
            )
            response = connection.getresponse()
            response.read()
            if response.status not in {200, 201, 204}:
                raise WorkerError("RUNPOD_UPLOAD_FAILED", "Runpod could not upload a render")
    finally:
        connection.close()


def _materialize_captions(raw: Any, directory: Path) -> List[Dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    directory.mkdir(parents=True, exist_ok=True)
    values = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        clip_id = str(item.get("clipId") or "")
        if not clip_id:
            continue
        ass = directory / (clip_id + ".ass")
        srt = directory / (clip_id + ".srt")
        ass.write_text(str(item.get("ass") or ""), encoding="utf-8")
        srt.write_text(str(item.get("srt") or ""), encoding="utf-8")
        values.append({"clipId": clip_id, "ass": str(ass), "srt": str(srt)})
    return values


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _metrics(started: float, model: str) -> Dict[str, Any]:
    return {
        "gpuSeconds": round(time.monotonic() - started, 3),
        "model": "media-worker-gpu-serverless:%s" % model,
    }


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


def _remaining_after_gpu(value: Any, started: float, settings: Settings) -> Any:
    remaining = _optional_float(value)
    if remaining is None:
        return None
    estimated_gpu_cost = max(0.0, time.monotonic() - started) * settings.runpod_cost_usd_per_second
    return max(0.0, remaining - estimated_gpu_cost)


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
