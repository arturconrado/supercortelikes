import json
import os
import shutil
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict

from .config import Settings
from .errors import WorkerError
from .models import StorageObject
from .process import run_command


ALLOWED_SOURCE_SUFFIXES = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}
YTDLP_SOURCE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtu.be",
    "loom.com",
    "www.loom.com",
    "drive.google.com",
}
YOUTUBE_FORMAT_SELECTOR = (
    "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/"
    "bv*[ext=mp4]+ba[ext=m4a]/"
    "b[ext=mp4]/"
    "bestvideo*+bestaudio/best"
)
YOUTUBE_AUTH_FAILURE_MARKERS = (
    "sign in to confirm",
    "not a bot",
    "use --cookies",
    "cookies-from-browser",
    "login required",
    "private video",
    "confirm your age",
)


def materialize_source(uri: str, target_dir: Path, settings: Settings) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    parsed = urllib.parse.urlparse(uri)
    host = (parsed.hostname or "").lower()
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}:
        return _download_youtube(uri, target_dir, settings)
    if host in YTDLP_SOURCE_HOSTS:
        return _download_with_ytdlp(uri, target_dir, settings)
    suffix = Path(urllib.parse.unquote(parsed.path)).suffix.lower()
    if parsed.scheme in {"http", "https"} and suffix not in ALLOWED_SOURCE_SUFFIXES:
        return _download_with_ytdlp(uri, target_dir, settings)
    if suffix not in ALLOWED_SOURCE_SUFFIXES:
        suffix = ".media"
    destination = target_dir / ("source" + suffix)
    if destination.is_file() and destination.stat().st_size > 0:
        return destination

    if parsed.scheme in {"", "file"}:
        source = Path(
            urllib.request.url2pathname(parsed.path) if parsed.scheme == "file" else uri
        ).resolve()
        if not source.is_file():
            raise WorkerError(
                "SOURCE_NOT_FOUND", "Local media source does not exist", status_code=404
            )
        if source.stat().st_size > settings.max_download_bytes:
            raise WorkerError(
                "SOURCE_TOO_LARGE",
                "Media source exceeds configured size limit",
                status_code=413,
            )
        _copy_atomic(source, destination)
        return destination

    if parsed.scheme not in {"http", "https"}:
        raise WorkerError(
            "SOURCE_SCHEME_UNSUPPORTED",
            "Only local, HTTP, and HTTPS media sources are accepted",
        )
    request = urllib.request.Request(
        uri, headers={"User-Agent": "SuperCortesLikes-MediaWorker/1.0"}
    )
    temporary = destination.with_suffix(destination.suffix + ".part")
    total = 0
    try:
        with (
            urllib.request.urlopen(
                request, timeout=settings.request_timeout_seconds
            ) as response,
            temporary.open("wb") as output,
        ):
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > settings.max_download_bytes:
                raise WorkerError(
                    "SOURCE_TOO_LARGE",
                    "Remote media source exceeds configured size limit",
                    status_code=413,
                )
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > settings.max_download_bytes:
                    raise WorkerError(
                        "SOURCE_TOO_LARGE",
                        "Remote media source exceeds configured size limit",
                        status_code=413,
                    )
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if total == 0:
            raise WorkerError("SOURCE_EMPTY", "Remote media source is empty")
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return destination


def _download_youtube(uri: str, target_dir: Path, settings: Settings) -> Path:
    return _download_with_ytdlp(uri, target_dir, settings)


def _download_with_ytdlp(uri: str, target_dir: Path, settings: Settings) -> Path:
    try:
        import yt_dlp
    except ImportError as error:
        from .errors import DependencyUnavailable

        raise DependencyUnavailable('yt-dlp', 'yt-dlp is required for URL imports') from error
    target_dir.mkdir(parents=True, exist_ok=True)
    existing = _downloaded_sources(target_dir)
    if existing:
        return existing[0]
    options = {
        'format': YOUTUBE_FORMAT_SELECTOR,
        'outtmpl': str(target_dir / 'source.%(ext)s'),
        'merge_output_format': 'mp4',
        'noplaylist': True,
        'max_filesize': settings.max_download_bytes,
        'socket_timeout': settings.request_timeout_seconds,
        'retries': 3,
        'js_runtimes': {'deno': {}},
        'remote_components': {'ejs:github'},
        'quiet': True,
        'no_warnings': True,
    }
    _configure_ytdlp_runtime(options, settings)
    try:
        with yt_dlp.YoutubeDL(options) as downloader:
            info = downloader.extract_info(uri, download=True)
            _write_source_metadata(info, target_dir)
    except Exception as error:
        raise _ytdlp_worker_error(uri, error, settings) from error
    downloaded = _downloaded_sources(target_dir)
    if not downloaded:
        raise WorkerError('URL_IMPORT_EMPTY', 'URL import produced no media file', status_code=502)
    result = downloaded[0]
    if result.stat().st_size > settings.max_download_bytes:
        result.unlink(missing_ok=True)
        raise WorkerError('SOURCE_TOO_LARGE', 'YouTube video exceeds configured size limit', status_code=413)
    return result


def _configure_ytdlp_runtime(options: Dict[str, Any], settings: Settings) -> None:
    if settings.ytdlp_cookies_file:
        options["cookiefile"] = settings.ytdlp_cookies_file
    if settings.ytdlp_proxy:
        options["proxy"] = settings.ytdlp_proxy
    if settings.ytdlp_user_agent:
        options["http_headers"] = {"User-Agent": settings.ytdlp_user_agent}


def _ytdlp_worker_error(uri: str, error: Exception, settings: Settings) -> WorkerError:
    text = str(error)
    lower = text.lower()
    host = (urllib.parse.urlparse(uri).hostname or "").lower()
    is_youtube = host in {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}
    if is_youtube and any(marker in lower for marker in YOUTUBE_AUTH_FAILURE_MARKERS):
        if settings.ytdlp_cookies_file:
            message = (
                "O YouTube recusou a importação automática deste link. "
                "Atualize os cookies do importador na VPS ou envie o arquivo manualmente."
            )
        else:
            message = (
                "O YouTube bloqueou a importação automática deste link. "
                "Envie o arquivo manualmente ou configure cookies do YouTube no importador."
            )
        return WorkerError(
            "URL_IMPORT_AUTH_REQUIRED",
            message,
            status_code=502,
            detail={
                "provider": "youtube",
                "cookiesConfigured": bool(settings.ytdlp_cookies_file),
                "reason": "provider_auth_or_bot_check",
            },
        )
    return WorkerError(
        "URL_IMPORT_FAILED",
        "Não foi possível importar este link. Tente outro link público ou envie o arquivo manualmente.",
        status_code=502,
        detail={"provider": host or "unknown", "reason": "download_failed"},
    )


def _downloaded_sources(target_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in target_dir.glob("source.*")
        if path.is_file()
        and not path.name.endswith(".part")
        and path.suffix.lower() in ALLOWED_SOURCE_SUFFIXES
    )


def _write_source_metadata(info: Any, target_dir: Path) -> None:
    if not isinstance(info, dict):
        return
    metadata = {
        key: info.get(key)
        for key in ("id", "title", "uploader", "channel", "webpage_url", "duration", "thumbnail")
        if info.get(key) not in (None, "")
    }
    if not metadata:
        return
    (target_dir / "source.metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, sort_keys=True),
        encoding="utf-8",
    )


def materialize_storage(
    source: StorageObject, target_dir: Path, settings: Settings
) -> Path:
    if (
        not settings.s3_endpoint_url
        or not settings.s3_access_key_id
        or not settings.s3_secret_access_key
    ):
        raise WorkerError(
            "STORAGE_NOT_CONFIGURED",
            "S3/R2 endpoint and credentials must be configured in worker environment",
            status_code=503,
        )
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        from .errors import DependencyUnavailable

        raise DependencyUnavailable(
            "boto3", "boto3 is required to read an S3/R2 storage object"
        ) from error
    suffix = Path(source.key).suffix.lower()
    if suffix not in ALLOWED_SOURCE_SUFFIXES:
        suffix = ".media"
    target_dir.mkdir(parents=True, exist_ok=True)
    destination = target_dir / ("source" + suffix)
    if destination.is_file() and destination.stat().st_size > 0:
        return destination
    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(
            s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"}
        ),
    )
    arguments = {"Bucket": source.bucket, "Key": source.key}
    if source.version_id:
        arguments["VersionId"] = source.version_id
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        metadata = client.head_object(**arguments)
        if int(metadata.get("ContentLength", 0)) > settings.max_download_bytes:
            raise WorkerError(
                "SOURCE_TOO_LARGE",
                "Storage object exceeds configured size limit",
                status_code=413,
            )
        with temporary.open("wb") as output:
            extra = {"VersionId": source.version_id} if source.version_id else None
            client.download_fileobj(source.bucket, source.key, output, ExtraArgs=extra)
            output.flush()
            os.fsync(output.fileno())
        if temporary.stat().st_size == 0:
            raise WorkerError("SOURCE_EMPTY", "Storage object is empty")
        os.replace(temporary, destination)
    except WorkerError:
        temporary.unlink(missing_ok=True)
        raise
    except Exception as error:
        temporary.unlink(missing_ok=True)
        raise WorkerError(
            "STORAGE_READ_FAILED",
            "Unable to read media object from S3/R2",
            status_code=502,
        ) from error
    return destination


def _copy_atomic(source: Path, destination: Path) -> None:
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        with source.open("rb") as input_handle, temporary.open("wb") as output_handle:
            shutil.copyfileobj(input_handle, output_handle, 1024 * 1024)
            output_handle.flush()
            os.fsync(output_handle.fileno())
        os.replace(temporary, destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def extract_thumbnail(
    path: Path,
    target_dir: Path,
    settings: Settings,
    duration_seconds: float,
) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    output = target_dir / "thumbnail.jpg"
    if output.is_file() and output.stat().st_size > 0:
        return output
    seek = 0.0
    if duration_seconds > 2:
        seek = min(max(1.0, duration_seconds * 0.1), duration_seconds - 0.25)
    run_command(
        [
            settings.ffmpeg_binary,
            "-y",
            "-ss",
            "%.3f" % seek,
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=min(854\\,iw):-2",
            "-q:v",
            "3",
            str(output),
        ],
        timeout=120,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise WorkerError("THUMBNAIL_EMPTY", "FFmpeg did not produce a thumbnail")
    return output


def extract_frame_thumbnail(
    path: Path,
    target_dir: Path,
    settings: Settings,
    at_seconds: float,
    stem: str,
) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    safe_stem = "".join(char if char.isalnum() or char in {"-", "_"} else "-" for char in stem) or "frame"
    output = target_dir / ("%s.jpg" % safe_stem)
    if output.is_file() and output.stat().st_size > 0:
        return output
    run_command(
        [
            settings.ffmpeg_binary,
            "-y",
            "-ss",
            "%.3f" % max(0.0, at_seconds),
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-vf",
            "scale=min(640\\,iw):-2",
            "-q:v",
            "4",
            str(output),
        ],
        timeout=120,
    )
    if not output.is_file() or output.stat().st_size == 0:
        raise WorkerError("THUMBNAIL_EMPTY", "FFmpeg did not produce a clip thumbnail")
    return output


def detect_burned_in_subtitles(
    path: Path,
    target_dir: Path,
    settings: Settings,
    duration_seconds: float,
) -> Dict[str, Any]:
    confidence = _bottom_text_confidence(path, target_dir, settings, duration_seconds)
    subtitle_streams = _subtitle_stream_count(path, settings)
    return {
        "detected": confidence >= 0.58,
        "confidence": round(confidence, 3),
        "subtitleStreams": subtitle_streams,
        "method": "opencv-bottom-band-v1" if confidence > 0 else "unavailable",
    }


def probe_media(path: Path, settings: Settings) -> Dict[str, Any]:
    raw = run_command(
        [
            settings.ffprobe_binary,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            str(path),
        ],
        timeout=120,
        capture_json=True,
    )
    streams = raw.get("streams", [])
    video = next(
        (stream for stream in streams if stream.get("codec_type") == "video"), None
    )
    if video is None:
        raise WorkerError(
            "VIDEO_STREAM_MISSING", "Media source does not contain a video stream"
        )
    audio = next(
        (stream for stream in streams if stream.get("codec_type") == "audio"), None
    )
    duration = float(
        raw.get("format", {}).get("duration") or video.get("duration") or 0
    )
    if duration <= 0:
        raise WorkerError(
            "INVALID_MEDIA_DURATION", "Media duration is missing or invalid"
        )
    return {
        "durationSeconds": duration,
        "sizeBytes": int(raw.get("format", {}).get("size") or path.stat().st_size),
        "format": raw.get("format", {}).get("format_name", "unknown"),
        "subtitleStreams": len(
            [stream for stream in streams if stream.get("codec_type") == "subtitle"]
        ),
        "video": {
            "codec": video.get("codec_name"),
            "width": int(video.get("width") or 0),
            "height": int(video.get("height") or 0),
            "frameRate": _frame_rate(video.get("avg_frame_rate", "0/1")),
        },
        "audio": None
        if audio is None
        else {
            "codec": audio.get("codec_name"),
            "sampleRate": int(audio.get("sample_rate") or 0),
            "channels": int(audio.get("channels") or 0),
        },
    }


def _frame_rate(value: str) -> float:
    try:
        numerator, denominator = value.split("/", 1)
        return float(numerator) / float(denominator) if float(denominator) else 0.0
    except (AttributeError, ValueError, ZeroDivisionError):
        return 0.0


def _subtitle_stream_count(path: Path, settings: Settings) -> int:
    try:
        raw = run_command(
            [
                settings.ffprobe_binary,
                "-v",
                "error",
                "-select_streams",
                "s",
                "-show_entries",
                "stream=index",
                "-of",
                "json",
                str(path),
            ],
            timeout=60,
            capture_json=True,
        )
        return len(raw.get("streams", []))
    except BaseException:
        return 0


def _bottom_text_confidence(
    path: Path,
    target_dir: Path,
    settings: Settings,
    duration_seconds: float,
) -> float:
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore
    except BaseException:
        return 0.0
    target_dir.mkdir(parents=True, exist_ok=True)
    frame = target_dir / "subtitle-detect-frame.jpg"
    seek = min(max(1.0, duration_seconds * 0.45), max(1.0, duration_seconds - 0.25))
    try:
        run_command(
            [
                settings.ffmpeg_binary,
                "-y",
                "-ss",
                "%.3f" % seek,
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
                "-q:v",
                "4",
                str(frame),
            ],
            timeout=120,
        )
        image = cv2.imread(str(frame), cv2.IMREAD_GRAYSCALE)
        if image is None or image.size == 0:
            return 0.0
        height, width = image.shape[:2]
        roi = image[int(height * 0.58) : height, :]
        if roi.size == 0:
            return 0.0
        roi = cv2.GaussianBlur(roi, (3, 3), 0)
        edges = cv2.Canny(roi, 80, 160)
        contours, _hierarchy = cv2.findContours(
            edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        text_like = 0
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if h < 5 or w < 8:
                continue
            ratio = w / max(h, 1)
            if 0.8 <= ratio <= 18 and y > roi.shape[0] * 0.18 and w < width * 0.92:
                text_like += 1
        edge_density = float(np.count_nonzero(edges)) / float(edges.size)
        contour_score = min(1.0, text_like / 38.0)
        density_score = min(1.0, edge_density * 9.0)
        return max(0.0, min(1.0, (contour_score * 0.65) + (density_score * 0.35)))
    except BaseException:
        return 0.0
