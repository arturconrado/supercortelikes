import math
import re
from typing import Any, Dict, Mapping, Sequence, Set

from .llm import maybe_score_with_llm
from .segmentation import token_set


CATEGORY_TERMS: Mapping[str, Set[str]] = {
    "curiosity": {
        "segredo",
        "descobrir",
        "ninguém",
        "porquê",
        "porque",
        "verdade",
        "surpresa",
        "imagine",
        "revelar",
    },
    "authority": {
        "estudo",
        "dados",
        "pesquisa",
        "experiência",
        "especialista",
        "resultado",
        "comprovado",
        "anos",
    },
    "controversy": {
        "polêmica",
        "mentira",
        "errado",
        "discordo",
        "absurdo",
        "mito",
        "proibido",
        "debate",
    },
    "emotion": {
        "amor",
        "medo",
        "ódio",
        "feliz",
        "triste",
        "chocante",
        "incrível",
        "dor",
        "sonho",
    },
    "business": {
        "negócio",
        "empresa",
        "cliente",
        "vendas",
        "lucro",
        "mercado",
        "estratégia",
        "empreender",
    },
    "entertainment": {
        "história",
        "engraçado",
        "famoso",
        "filme",
        "música",
        "jogo",
        "viral",
        "diversão",
    },
    "educational": {
        "aprender",
        "passo",
        "dica",
        "como",
        "explicar",
        "método",
        "exemplo",
        "entender",
    },
    "financial": {
        "dinheiro",
        "investir",
        "renda",
        "preço",
        "custo",
        "milhão",
        "reais",
        "ações",
        "finanças",
    },
}


def score_segment(segment: Mapping[str, Any]) -> Dict[str, Any]:
    text = str(segment.get("text", ""))
    tokens = token_set(text)
    word_count = max(1, len(tokens))
    values: Dict[str, float] = {}
    for category, terms in CATEGORY_TERMS.items():
        matches = len(tokens & terms)
        density = matches / math.sqrt(word_count)
        values[category] = round(min(100.0, density * 70.0), 2)

    question_bonus = min(16.0, text.count("?") * 8.0)
    number_bonus = min(12.0, len(re.findall(r"\b\d+(?:[.,]\d+)?%?\b", text)) * 4.0)
    hook_bonus = (
        8.0
        if re.search(
            r"\b(você|vocês|imagine|atenção|pare|nunca|sempre)\b", text.lower()
        )
        else 0.0
    )
    emotion = segment.get("emotion", {})
    if emotion.get("label") != "neutral":
        values["emotion"] = min(
            100.0, values["emotion"] + float(emotion.get("confidence", 0)) * 25
        )
    category_mean = sum(values.values()) / len(values)
    top_strength = max(values.values())
    pacing = _pacing_score(
        text, float(segment.get("end", 0)) - float(segment.get("start", 0))
    )
    final = min(
        100.0,
        category_mean * 0.48
        + top_strength * 0.25
        + pacing * 0.15
        + question_bonus
        + number_bonus
        + hook_bonus,
    )
    return {
        "segmentId": segment.get("id"),
        "score": round(final, 2),
        "categories": {key: round(value, 2) for key, value in values.items()},
        "signals": {
            "question": question_bonus,
            "numbers": number_bonus,
            "directAddress": hook_bonus,
            "pacing": pacing,
        },
    }


def score_all(segments: Sequence[Mapping[str, Any]], settings: Any = None) -> Dict[str, Any]:
    scores = [score_segment(segment) for segment in segments]
    lexical_result = {
        "algorithmVersion": "viral-lexical-v1",
        "scores": scores,
        "averageScore": round(sum(item["score"] for item in scores) / len(scores), 2)
        if scores
        else 0.0,
    }
    if settings is None:
        return lexical_result
    return maybe_score_with_llm(segments, lexical_result, settings) or lexical_result


def _pacing_score(text: str, duration: float) -> float:
    if duration <= 0:
        return 0.0
    words_per_minute = len(text.split()) * 60.0 / duration
    distance = abs(words_per_minute - 155.0)
    return round(max(0.0, 100.0 - distance * 0.8), 2)
