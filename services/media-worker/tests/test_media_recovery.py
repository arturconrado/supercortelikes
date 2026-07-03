import sys
from dataclasses import replace
from types import SimpleNamespace

import pytest

from media_worker.config import Settings
from media_worker.errors import WorkerError
from media_worker.media import (
    YOUTUBE_FORMAT_SELECTOR,
    materialize_source,
    materialize_storage,
    probe_media,
    _download_youtube,
    _frame_rate,
)
from media_worker.models import StorageObject


def configured_settings(**changes):
    return replace(
        Settings.from_env(),
        max_download_bytes=32,
        request_timeout_seconds=1,
        s3_endpoint_url="http://storage",
        s3_access_key_id="access",
        s3_secret_access_key="secret",
        s3_bucket="bucket",
        **changes,
    )


class Response:
    def __init__(self, chunks, content_length=None):
        self.chunks = iter(chunks)
        self.headers = {} if content_length is None else {"Content-Length": str(content_length)}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _size):
        return next(self.chunks, b"")


def test_materialize_source_local_cached_and_validation(tmp_path, monkeypatch):
    settings = configured_settings()
    source = tmp_path / "input.mp4"
    source.write_bytes(b"video")
    output = tmp_path / "output"

    result = materialize_source(str(source), output, settings)
    assert result.read_bytes() == b"video"
    assert materialize_source(str(source), output, settings) == result

    unknown = tmp_path / "input.bin"
    unknown.write_bytes(b"media")
    assert materialize_source(str(unknown), tmp_path / "unknown", settings).suffix == ".media"

    with pytest.raises(WorkerError, match="does not exist"):
        materialize_source(str(tmp_path / "missing.mp4"), tmp_path / "missing", settings)
    with pytest.raises(WorkerError, match="size limit"):
        materialize_source(str(source), tmp_path / "large", replace(settings, max_download_bytes=2))
    with pytest.raises(WorkerError, match="Only local"):
        materialize_source("ftp://example.test/video.mp4", tmp_path / "ftp", settings)

    monkeypatch.setattr("media_worker.media._download_youtube", lambda *_args: tmp_path / "youtube.mp4")
    assert materialize_source("https://youtu.be/example", tmp_path / "youtube", settings).name == "youtube.mp4"

    monkeypatch.setattr("media_worker.media._download_with_ytdlp", lambda *_args: tmp_path / "provider.mp4")
    assert materialize_source("https://provider.example/watch/abc", tmp_path / "provider", settings).name == "provider.mp4"


def test_youtube_import_prefers_cpu_friendly_mp4_formats():
    assert YOUTUBE_FORMAT_SELECTOR.startswith("bv*[height<=1080][ext=mp4][vcodec^=avc1]+ba[ext=m4a]")
    assert "best[height<=1080]" in YOUTUBE_FORMAT_SELECTOR
    assert "bv*[height<=1080]+ba" in YOUTUBE_FORMAT_SELECTOR


def test_youtube_download_configures_deno_runtime(tmp_path, monkeypatch):
    class YoutubeDL:
        options = {}

        def __init__(self, options):
            YoutubeDL.options = options

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _uri, download):
            assert download is True
            (tmp_path / "source.mp4").write_bytes(b"video")
            return {"id": "VYDE529RzNk", "title": "Título real do vídeo", "uploader": "Canal"}

    monkeypatch.setitem(sys.modules, "yt_dlp", SimpleNamespace(YoutubeDL=YoutubeDL))

    result = _download_youtube("https://www.youtube.com/watch?v=VYDE529RzNk", tmp_path, configured_settings())

    assert result == tmp_path / "source.mp4"
    assert YoutubeDL.options["format"] == YOUTUBE_FORMAT_SELECTOR
    assert YoutubeDL.options["js_runtimes"] == {"deno": {}}
    assert YoutubeDL.options["remote_components"] == {"ejs:github"}
    assert YoutubeDL.options["fragment_retries"] == 5
    assert YoutubeDL.options["extractor_retries"] == 3
    assert YoutubeDL.options["concurrent_fragment_downloads"] == 2
    assert YoutubeDL.options["continuedl"] is True
    assert YoutubeDL.options["playlist_items"] == "1"
    assert "Mozilla/5.0" in YoutubeDL.options["http_headers"]["User-Agent"]
    assert (tmp_path / "source.metadata.json").read_text(encoding="utf-8")


def test_youtube_download_uses_optional_cookies_proxy_and_user_agent(tmp_path, monkeypatch):
    cookies = tmp_path / "youtube-cookies.txt"
    cookies.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")

    class YoutubeDL:
        options = {}

        def __init__(self, options):
            YoutubeDL.options = options

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _uri, download):
            assert download is True
            (tmp_path / "source.mp4").write_bytes(b"video")
            return {"id": "VYDE529RzNk"}

    monkeypatch.setitem(sys.modules, "yt_dlp", SimpleNamespace(YoutubeDL=YoutubeDL))

    _download_youtube(
        "https://www.youtube.com/watch?v=VYDE529RzNk",
        tmp_path,
        configured_settings(
            ytdlp_cookies_file=str(cookies),
            ytdlp_proxy="http://proxy.example:8080",
            ytdlp_user_agent="PicaShortsImport/1.0",
        ),
    )

    assert YoutubeDL.options["cookiefile"] == str(cookies)
    assert YoutubeDL.options["proxy"] == "http://proxy.example:8080"
    assert YoutubeDL.options["http_headers"] == {"User-Agent": "PicaShortsImport/1.0"}


def test_youtube_auth_failure_is_actionable(tmp_path, monkeypatch):
    class YoutubeDL:
        def __init__(self, _options):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def extract_info(self, _uri, download):
            assert download is True
            raise RuntimeError("Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies")

    monkeypatch.setitem(sys.modules, "yt_dlp", SimpleNamespace(YoutubeDL=YoutubeDL))

    with pytest.raises(WorkerError) as error:
        _download_youtube("https://www.youtube.com/watch?v=VYDE529RzNk", tmp_path, configured_settings())

    assert error.value.code == "URL_IMPORT_AUTH_REQUIRED"
    assert "YouTube bloqueou" in str(error.value)
    assert error.value.detail == {
        "provider": "youtube",
        "cookiesConfigured": False,
        "reason": "provider_auth_or_bot_check",
    }


def test_materialize_source_http_paths(tmp_path, monkeypatch):
    settings = configured_settings()
    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response([b"abc", b"def"]))
    result = materialize_source("https://example.test/video.mp4", tmp_path / "valid", settings)
    assert result.read_bytes() == b"abcdef"

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response([], content_length=64))
    with pytest.raises(WorkerError, match="size limit"):
        materialize_source("https://example.test/large.mp4", tmp_path / "header-large", settings)

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response([b"abcdef"]))
    with pytest.raises(WorkerError, match="size limit"):
        materialize_source(
            "https://example.test/stream-large.mp4",
            tmp_path / "stream-large",
            replace(settings, max_download_bytes=2),
        )

    monkeypatch.setattr("urllib.request.urlopen", lambda *_args, **_kwargs: Response([]))
    with pytest.raises(WorkerError, match="empty"):
        materialize_source("https://example.test/empty.mp4", tmp_path / "empty", settings)


class StorageClient:
    def __init__(self, content=b"video", length=5, failure=None):
        self.content = content
        self.length = length
        self.failure = failure
        self.head_arguments = None
        self.extra = None

    def head_object(self, **arguments):
        self.head_arguments = arguments
        if self.failure:
            raise self.failure
        return {"ContentLength": self.length}

    def download_fileobj(self, _bucket, _key, output, ExtraArgs=None):
        self.extra = ExtraArgs
        output.write(self.content)


def install_storage_client(monkeypatch, client):
    monkeypatch.setitem(sys.modules, "boto3", SimpleNamespace(client=lambda *_args, **_kwargs: client))
    monkeypatch.setitem(
        sys.modules,
        "botocore.config",
        SimpleNamespace(Config=lambda **kwargs: kwargs),
    )


def test_materialize_storage_success_cache_and_version(tmp_path, monkeypatch):
    settings = configured_settings(s3_force_path_style=True)
    client = StorageClient()
    install_storage_client(monkeypatch, client)
    source = StorageObject(bucket="bucket", key="videos/source.mp4", versionId="v1")
    result = materialize_storage(source, tmp_path / "storage", settings)
    assert result.read_bytes() == b"video"
    assert client.head_arguments["VersionId"] == "v1"
    assert client.extra == {"VersionId": "v1"}
    assert materialize_storage(source, tmp_path / "storage", settings) == result

    no_version_client = StorageClient()
    install_storage_client(monkeypatch, no_version_client)
    unknown = StorageObject(bucket="bucket", key="videos/source.unknown")
    assert materialize_storage(unknown, tmp_path / "unknown-storage", settings).suffix == ".media"
    assert no_version_client.extra is None


def test_materialize_storage_failure_paths(tmp_path, monkeypatch):
    source = StorageObject(bucket="bucket", key="videos/source.mp4")
    settings = configured_settings()
    with pytest.raises(WorkerError, match="must be configured"):
        materialize_storage(source, tmp_path / "missing-config", replace(settings, s3_endpoint_url=""))

    install_storage_client(monkeypatch, StorageClient(length=64))
    with pytest.raises(WorkerError, match="size limit"):
        materialize_storage(source, tmp_path / "large", settings)

    install_storage_client(monkeypatch, StorageClient(content=b"", length=0))
    with pytest.raises(WorkerError, match="empty"):
        materialize_storage(source, tmp_path / "empty", settings)

    install_storage_client(monkeypatch, StorageClient(failure=RuntimeError("storage down")))
    with pytest.raises(WorkerError, match="Unable to read"):
        materialize_storage(source, tmp_path / "failed", settings)


def test_probe_media_contract_and_errors(tmp_path, monkeypatch):
    path = tmp_path / "source.mp4"
    path.write_bytes(b"video")
    settings = configured_settings()

    monkeypatch.setattr(
        "media_worker.media.run_command",
        lambda *_args, **_kwargs: {
            "format": {"duration": "2.5", "size": "5", "format_name": "mov,mp4"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 640, "height": 360, "avg_frame_rate": "30/1"},
                {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000", "channels": 2},
            ],
        },
    )
    result = probe_media(path, settings)
    assert result["video"]["frameRate"] == 30
    assert result["audio"]["codec"] == "aac"

    monkeypatch.setattr(
        "media_worker.media.run_command",
        lambda *_args, **_kwargs: {"format": {"duration": "1"}, "streams": [{"codec_type": "video", "duration": "1"}]},
    )
    assert probe_media(path, settings)["audio"] is None

    monkeypatch.setattr("media_worker.media.run_command", lambda *_args, **_kwargs: {"streams": []})
    with pytest.raises(WorkerError, match="video stream"):
        probe_media(path, settings)

    monkeypatch.setattr(
        "media_worker.media.run_command",
        lambda *_args, **_kwargs: {"format": {}, "streams": [{"codec_type": "video", "duration": "0"}]},
    )
    with pytest.raises(WorkerError, match="duration"):
        probe_media(path, settings)

    assert _frame_rate("30/0") == 0
    assert _frame_rate("invalid") == 0
