import json
from pathlib import Path
from types import SimpleNamespace

from media_worker import speaker_ai
from media_worker.openrouter_video import OpenRouterVideoError


def _settings(**overrides):
    values = {
        "openrouter_active_speaker_enabled": True,
        "openrouter_video_enabled": True,
        "llm_provider": "openrouter",
        "llm_api_key": "secret",
        "openrouter_video_model": "google/gemini-2.5-flash",
        "llm_provider_sort": "latency",
        "ffmpeg_binary": "ffmpeg",
        "openrouter_video_max_bytes": 20 * 1024 * 1024,
        "openrouter_video_timeout_seconds": 10,
        "openrouter_video_retries": 3,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_enabled_requires_both_video_and_active_speaker_flags():
    assert speaker_ai.enabled(_settings()) is True
    assert speaker_ai.enabled(_settings(openrouter_active_speaker_enabled=False)) is False
    assert speaker_ai.enabled(_settings(openrouter_video_enabled=False)) is False
    assert speaker_ai.enabled(_settings(llm_provider="none")) is False


def test_analyze_clip_speakers_returns_none_when_disabled(tmp_path):
    intervals, usage = speaker_ai.analyze_clip_speakers(
        tmp_path / "source.mp4",
        {"id": "clip-1", "start": 0, "end": 2},
        _settings(openrouter_active_speaker_enabled=False),
        tmp_path,
    )

    assert intervals is None
    assert usage is None


def test_analyze_clip_speakers_returns_none_when_budget_exhausted(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(speaker_ai, "create_proxy", lambda *args, **kwargs: calls.append(1))

    intervals, usage = speaker_ai.analyze_clip_speakers(
        tmp_path / "source.mp4",
        {"id": "clip-1", "start": 0, "end": 2},
        _settings(),
        tmp_path,
        cost_remaining_usd=0,
    )

    assert intervals is None
    assert usage is None
    assert calls == []  # never attempts proxy creation / network work


def test_analyze_clip_speakers_returns_none_when_proxy_creation_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(speaker_ai, "create_proxy", lambda *args, **kwargs: None)

    intervals, usage = speaker_ai.analyze_clip_speakers(
        tmp_path / "source.mp4",
        {"id": "clip-1", "start": 0, "end": 2},
        _settings(),
        tmp_path,
    )

    assert intervals is None
    assert usage is None


def test_analyze_clip_speakers_degrades_gracefully_on_openrouter_error(tmp_path, monkeypatch):
    proxy = tmp_path / "proxy.mp4"
    proxy.write_bytes(b"proxy")
    monkeypatch.setattr(speaker_ai, "create_proxy", lambda *args, **kwargs: proxy)

    def fail(*_args, **_kwargs):
        raise OpenRouterVideoError("boom")

    monkeypatch.setattr(speaker_ai, "analyze_video", fail)

    intervals, usage = speaker_ai.analyze_clip_speakers(
        tmp_path / "source.mp4",
        {"id": "clip-1", "start": 0, "end": 2},
        _settings(),
        tmp_path,
    )

    assert intervals is None
    assert usage is None


def test_analyze_clip_speakers_parses_a_successful_response(tmp_path, monkeypatch):
    proxy = tmp_path / "proxy.mp4"
    proxy.write_bytes(b"proxy")
    monkeypatch.setattr(speaker_ai, "create_proxy", lambda *args, **kwargs: proxy)

    content = json.dumps(
        {
            "activity": [
                {
                    "startMs": 0,
                    "endMs": 1000,
                    "speakers": [{"xRatio": 0.3, "yRatio": 0.4}],
                    "crossTalk": False,
                },
                {
                    "startMs": 1000,
                    "endMs": 2000,
                    "speakers": [
                        {"xRatio": 0.3, "yRatio": 0.4},
                        {"xRatio": 0.7, "yRatio": 0.4},
                    ],
                    "crossTalk": True,
                },
            ]
        }
    )

    def fake_analyze_video(_proxy, _prompt, _settings, max_tokens):
        assert max_tokens == 900
        return {"content": content, "usage": {"costUsd": 0.01}}

    monkeypatch.setattr(speaker_ai, "analyze_video", fake_analyze_video)

    intervals, usage = speaker_ai.analyze_clip_speakers(
        tmp_path / "source.mp4",
        {"id": "clip-1", "start": 10, "end": 12},
        _settings(),
        tmp_path,
    )

    assert usage == {"costUsd": 0.01}
    assert intervals is not None
    assert len(intervals) == 2
    assert intervals[0]["start"] == 10.0
    assert intervals[0]["end"] == 11.0
    assert intervals[1]["crossTalk"] is True
    assert len(intervals[1]["speakers"]) == 2


def test_speaker_prompt_response_schema_matches_parser():
    clip = {"id": "clip-1", "start": 0, "end": 2}
    prompt = speaker_ai._speaker_prompt(clip)
    example = prompt["response"]["activity"][0]

    intervals = speaker_ai._parse_intervals(
        json.dumps({"activity": [example]}), clip
    )

    assert intervals is not None
    assert intervals[0]["speakers"][0]["xRatio"] == example["speakers"][0]["xRatio"]
    assert intervals[0]["crossTalk"] == example["crossTalk"]


def test_parse_intervals_returns_none_on_malformed_or_empty_payloads():
    clip = {"id": "clip-1", "start": 0, "end": 1}
    assert speaker_ai._parse_intervals("not json", clip) is None
    assert speaker_ai._parse_intervals(json.dumps({"nope": []}), clip) is None
    assert speaker_ai._parse_intervals(json.dumps({"activity": []}), clip) is None
    # A window with no speakers listed carries no usable signal.
    no_speakers = json.dumps(
        {"activity": [{"startMs": 0, "endMs": 1000, "speakers": [], "crossTalk": False}]}
    )
    assert speaker_ai._parse_intervals(no_speakers, clip) is None
