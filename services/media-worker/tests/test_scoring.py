import http.client
import json
from threading import Lock

from media_worker import llm
from media_worker.scoring import score_all, score_segment


class Settings:
    llm_provider = "none"
    llm_api_key = ""
    llm_model = "openai/gpt-4o-mini"
    llm_timeout_seconds = 5


def test_viral_signals_raise_score_and_expose_eight_categories():
    plain = {
        "id": 1,
        "start": 0,
        "end": 20,
        "text": "Hoje falamos sobre uma cadeira.",
        "emotion": {"label": "neutral"},
    }
    viral = {
        "id": 2,
        "start": 0,
        "end": 20,
        "text": "Você conhece os 3 segredos comprovados para ganhar dinheiro? Ninguém revela este método incrível.",
        "emotion": {"label": "surprise", "confidence": 0.9},
    }
    plain_score = score_segment(plain)
    viral_score = score_segment(viral)
    assert viral_score["score"] > plain_score["score"]
    assert len(viral_score["categories"]) == 8
    assert 0 <= viral_score["score"] <= 100


def test_score_all_calculates_average():
    segments = [
        {
            "id": 1,
            "start": 0,
            "end": 10,
            "text": "Como aprender com um exemplo",
            "emotion": {"label": "neutral"},
        },
        {
            "id": 2,
            "start": 10,
            "end": 20,
            "text": "Dados de pesquisa comprovam o resultado",
            "emotion": {"label": "neutral"},
        },
    ]
    result = score_all(segments)
    assert len(result["scores"]) == 2
    expected = round(sum(value["score"] for value in result["scores"]) / 2, 2)
    assert result["averageScore"] == expected


def test_score_all_uses_openrouter_when_configured(monkeypatch):
    segments = [
        {
            "id": "segment-1",
            "start": 0,
            "end": 10,
            "text": "Você conhece o segredo para criar cortes melhores?",
            "emotion": {"label": "surprise", "confidence": 0.8},
        }
    ]

    def fake_llm(given_segments, lexical_result, settings):
        assert given_segments == segments
        assert settings.llm_provider == "openrouter"
        assert lexical_result["scores"]
        return {
            "algorithmVersion": "viral-openrouter-v1",
            "scores": [
                {
                    "segmentId": "segment-1",
                    "score": 97,
                    "categories": lexical_result["scores"][0]["categories"],
                    "signals": {"hook": 90},
                }
            ],
            "averageScore": 97,
        }

    monkeypatch.setattr("media_worker.scoring.maybe_score_with_llm", fake_llm)
    settings = Settings()
    settings.llm_provider = "openrouter"
    settings.llm_api_key = "secret"
    result = score_all(segments, settings)
    assert result["algorithmVersion"] == "viral-openrouter-v1"
    assert result["scores"][0]["score"] == 97


def test_score_all_keeps_lexical_fallback_when_openrouter_fails(monkeypatch):
    segments = [
        {
            "id": "segment-1",
            "start": 0,
            "end": 10,
            "text": "Um exemplo simples para fallback.",
            "emotion": {"label": "neutral"},
        }
    ]

    monkeypatch.setattr("media_worker.scoring.maybe_score_with_llm", lambda *_args: None)
    settings = Settings()
    settings.llm_provider = "openrouter"
    settings.llm_api_key = "secret"
    result = score_all(segments, settings)
    assert result["algorithmVersion"] == "viral-lexical-v1"


def test_openrouter_transport_disconnect_returns_lexical_fallback(monkeypatch):
    segments = [
        {
            "id": "segment-1",
            "start": 0,
            "end": 10,
            "text": "Um exemplo sintético sem dados de usuário.",
            "emotion": {"label": "neutral"},
        }
    ]
    lexical = score_all(segments)
    settings = Settings()
    settings.llm_provider = "openrouter"
    settings.llm_api_key = "secret"

    def disconnected(*_args, **_kwargs):
        raise http.client.RemoteDisconnected("provider closed the connection")

    monkeypatch.setattr(llm.urllib.request, "urlopen", disconnected)

    assert llm.maybe_score_with_llm(segments, lexical, settings) is None


def test_openrouter_scores_large_inputs_in_bounded_batches(monkeypatch):
    segments = [
        {
            "id": f"segment-{index}",
            "start": index * 10,
            "end": index * 10 + 10,
            "text": f"Exemplo sintético {index} sem dados de usuário.",
            "emotion": {"label": "neutral"},
        }
        for index in range(17)
    ]
    lexical = score_all(segments)
    settings = Settings()
    settings.llm_provider = "openrouter"
    settings.llm_api_key = "secret"
    calls = []
    calls_lock = Lock()

    class Response:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(self.body).encode("utf-8")

    def respond(request, **_kwargs):
        payload = json.loads(request.data)
        user_payload = json.loads(payload["messages"][1]["content"])
        batch = user_payload["segments"]
        with calls_lock:
            calls.append([item["id"] for item in batch])
        scores = [
            {
                "segmentId": item["id"],
                "score": 80,
                "categories": {},
                "signals": {},
                "editorial": {},
            }
            for item in batch
        ]
        return Response(
            {
                "id": f"request-{batch[0]['id']}",
                "choices": [
                    {
                        "finish_reason": "stop",
                        "message": {"content": json.dumps(scores)},
                    }
                ],
                "usage": {"total_tokens": 100, "cost": 0.001},
            }
        )

    monkeypatch.setattr(llm.urllib.request, "urlopen", respond)

    result = llm.maybe_score_with_llm(segments, lexical, settings)

    assert result is not None
    assert result["algorithmVersion"] == "viral-openrouter-v1"
    assert len(result["scores"]) == 17
    assert len(result["providerUsage"]) == 3
    assert sorted(len(batch) for batch in calls) == [1, 8, 8]
    assert [item["segmentId"] for item in result["scores"]] == [
        item["id"] for item in segments
    ]
