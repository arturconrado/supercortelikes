import re
from typing import Any, Dict, List, Mapping, Sequence, Tuple


def find_clips(
    segments: Sequence[Mapping[str, Any]],
    scores: Sequence[Mapping[str, Any]],
    *,
    minimum_duration: float = 15.0,
    maximum_duration: float = 90.0,
    requested_count: int = 20,
) -> List[Dict[str, Any]]:
    if not segments:
        return []
    requested_count = max(1, min(30, requested_count))
    score_by_id = {
        value.get("segmentId"): float(value.get("score", 0)) for value in scores
    }
    candidates: List[Tuple[float, int, int]] = []
    for start_index in range(len(segments)):
        for end_index in range(start_index, len(segments)):
            duration = float(segments[end_index]["end"]) - float(
                segments[start_index]["start"]
            )
            if duration > maximum_duration:
                break
            if duration >= minimum_duration or (
                start_index == end_index and len(segments) == 1
            ):
                values = segments[start_index : end_index + 1]
                base = sum(
                    score_by_id.get(value.get("id"), 0.0) for value in values
                ) / len(values)
                duration_fit = max(0.0, 10.0 - abs(duration - 42.0) / 5.0)
                cohesion = max(0.0, 5.0 - (len(values) - 1) * 0.7)
                candidates.append(
                    (min(100.0, base + duration_fit + cohesion), start_index, end_index)
                )
    candidates.sort(reverse=True)
    selected: List[Tuple[float, int, int]] = []
    for candidate in candidates:
        if len(selected) >= requested_count:
            break
        _, start_index, end_index = candidate
        start = float(segments[start_index]["start"])
        end = float(segments[end_index]["end"])
        if any(
            overlap_ratio(
                start, end, float(segments[a]["start"]), float(segments[b]["end"])
            )
            > 0.55
            for _, a, b in selected
        ):
            continue
        selected.append(candidate)
    if not selected:
        selected.append(
            (score_by_id.get(segments[0].get("id"), 0.0), 0, len(segments) - 1)
        )
    return [_build_clip(index, value, segments) for index, value in enumerate(selected)]


def overlap_ratio(start_a: float, end_a: float, start_b: float, end_b: float) -> float:
    intersection = max(0.0, min(end_a, end_b) - max(start_a, start_b))
    shorter = min(end_a - start_a, end_b - start_b)
    return intersection / shorter if shorter > 0 else 0.0


def _build_clip(
    index: int, candidate: Tuple[float, int, int], segments: Sequence[Mapping[str, Any]]
) -> Dict[str, Any]:
    score, start_index, end_index = candidate
    values = segments[start_index : end_index + 1]
    text = " ".join(str(value.get("text", "")) for value in values).strip()
    title_seed = _title_seed(text)
    genre = _genre(text)
    hook = _hook(text)
    return {
        "id": "clip-%03d" % (index + 1),
        "start": round(float(values[0]["start"]), 3),
        "end": round(float(values[-1]["end"]), 3),
        "durationSeconds": round(
            float(values[-1]["end"]) - float(values[0]["start"]), 3
        ),
        "score": round(score, 2),
        "titleSuggestions": [
            title_seed,
            "O que ninguém te contou sobre %s" % title_seed.lower(),
            "%s: entenda em poucos segundos" % title_seed,
        ],
        "reason": "Trecho autossuficiente priorizado por força do gancho, densidade temática e duração",
        "genre": genre,
        "hook": hook,
        "segmentIds": [value.get("id") for value in values],
        "text": text,
    }


def _title_seed(text: str) -> str:
    sentence = re.split(r"[.!?\n]", text.strip())[0]
    words = sentence.split()
    if not words:
        return "Momento de destaque"
    value = " ".join(words[:10]).strip(' ,:;-"')
    return value[0].upper() + value[1:] if value else "Momento de destaque"


def _hook(text: str) -> str:
    sentences = [value.strip() for value in re.split(r"(?<=[.!?])\s+", text.strip()) if value.strip()]
    if not sentences:
        return _title_seed(text)
    scored = sorted(sentences[:5], key=_hook_score, reverse=True)
    return scored[0][:180]


def _hook_score(value: str) -> float:
    lower = value.lower()
    score = 0.0
    if "?" in value:
        score += 2.5
    if re.search(r"\b(você|vocês|ninguém|segredo|verdade|erro|pare|nunca|imagine)\b", lower):
        score += 3.0
    if re.search(r"\b\d+(?:[.,]\d+)?%?\b", value):
        score += 1.5
    if 45 <= len(value) <= 140:
        score += 1.0
    return score


def _genre(text: str) -> str:
    lower = text.lower()
    buckets = {
        "business": ("negócio", "empresa", "cliente", "vendas", "mercado", "empreender"),
        "education": ("aprender", "dica", "como", "método", "exemplo", "entender"),
        "finance": ("dinheiro", "investir", "renda", "reais", "finanças", "ações"),
        "entertainment": ("história", "engraçado", "filme", "música", "jogo", "viral"),
        "controversy": ("polêmica", "mentira", "errado", "mito", "discordo", "absurdo"),
    }
    ranked = sorted(
        ((sum(1 for term in terms if term in lower), name) for name, terms in buckets.items()),
        reverse=True,
    )
    return ranked[0][1] if ranked and ranked[0][0] > 0 else "general"
