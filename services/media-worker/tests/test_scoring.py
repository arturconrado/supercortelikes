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
