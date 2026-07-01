from media_worker.segmentation import (
    dominant_emotion,
    lexical_similarity,
    semantic_segments,
)


def test_segments_on_silence_and_speaker_change_after_target_duration():
    transcript = [
        {
            "id": 1,
            "start": 0.0,
            "end": 14.0,
            "speaker": "A",
            "text": "Aprenda este método com um exemplo prático",
        },
        {
            "id": 2,
            "start": 14.1,
            "end": 29.0,
            "speaker": "A",
            "text": "O método melhora resultados de negócios",
        },
        {
            "id": 3,
            "start": 31.0,
            "end": 45.0,
            "speaker": "B",
            "text": "Agora o assunto é investimento e renda",
        },
    ]
    result = semantic_segments(transcript, target_duration=25.0)
    assert len(result) == 2
    assert result[0]["start"] == 0.0
    assert result[0]["end"] == 29.0
    assert "silence" in result[0]["boundaryReasons"]
    assert result[1]["speakers"] == ["B"]


def test_lexical_similarity_and_emotion_are_deterministic():
    assert lexical_similarity("mercado cliente vendas", "cliente vendas lucro") == 0.5
    assert lexical_similarity("mercado", "alegria") == 0.0
    emotion = dominant_emotion("Que descoberta incrível, uma surpresa maravilhosa")
    assert emotion["label"] in {"joy", "surprise"}
    assert emotion["confidence"] > 0.5
