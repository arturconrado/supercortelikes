import re
from collections import Counter
from typing import Any, Dict, List, Optional

from .segmentation import STOPWORDS, TOKEN_PATTERN


TITLE_PATTERNS = [
    "{subject}: o que ninguém te conta",
    "A verdade sobre {subject}",
    "Como dominar {subject} na prática",
    "Por que {subject} muda tudo",
    "O erro que destrói seus resultados em {subject}",
    "3 lições essenciais sobre {subject}",
    "Você está fazendo {subject} errado?",
    "O método mais simples para {subject}",
    "Antes de tentar {subject}, veja isto",
    "O segredo por trás de {subject}",
    "Pare de ignorar isto em {subject}",
    "O guia direto de {subject}",
    "Como especialistas pensam sobre {subject}",
    "A decisão que transforma {subject}",
    "Tudo o que aprendi sobre {subject}",
    "O maior mito sobre {subject}",
    "Uma nova forma de enxergar {subject}",
    "O detalhe que faz diferença em {subject}",
    "Vale a pena investir em {subject}?",
    "Faça isto antes de começar {subject}",
]


def generate_seo(
    transcript: str, subject: Optional[str] = None, audience: Optional[str] = None
) -> Dict[str, Any]:
    keywords = extract_keywords(transcript, 15)
    resolved_subject = (subject or " ".join(keywords[:3]) or "este assunto").strip()
    titles = []
    for pattern in TITLE_PATTERNS:
        title = pattern.format(subject=resolved_subject)
        titles.append({"title": title, "ctrScore": ctr_score(title)})
    titles.sort(key=lambda value: value["ctrScore"], reverse=True)
    description_source = re.split(r"(?<=[.!?])\s+", " ".join(transcript.split()))
    summary = " ".join(description_source[:3])[:600].strip()
    audience_text = (
        " Conteúdo preparado para %s." % audience.strip() if audience else ""
    )
    hashtags = [
        "#" + re.sub(r"[^\wÀ-ÿ]", "", keyword.title()) for keyword in keywords[:12]
    ]
    return {
        "engine": "seo-rules-v1",
        "subject": resolved_subject,
        "titles": titles,
        "description": (summary + audience_text).strip(),
        "hashtags": list(dict.fromkeys(tag for tag in hashtags if len(tag) > 2)),
        "keywords": keywords,
    }


def extract_keywords(text: str, limit: int = 15) -> List[str]:
    tokens = [
        token.lower()
        for token in TOKEN_PATTERN.findall(text)
        if len(token) >= 3 and token.lower() not in STOPWORDS
    ]
    unigrams = Counter(tokens)
    bigrams = Counter(
        "%s %s" % pair for pair in zip(tokens, tokens[1:]) if pair[0] != pair[1]
    )
    ranked = [(term, count * 1.0) for term, count in unigrams.items()] + [
        (term, count * 1.7) for term, count in bigrams.items()
    ]
    ranked.sort(key=lambda value: (-value[1], -len(value[0]), value[0]))
    selected: List[str] = []
    for term, _ in ranked:
        if any(term in existing or existing in term for existing in selected):
            continue
        selected.append(term)
        if len(selected) >= limit:
            break
    return selected


def ctr_score(title: str) -> float:
    lower = title.lower()
    score = 45.0
    if any(term in lower for term in ("segredo", "verdade", "ninguém", "erro", "mito")):
        score += 16
    if any(character.isdigit() for character in title):
        score += 10
    if title.endswith("?"):
        score += 8
    if 35 <= len(title) <= 65:
        score += 12
    if any(term in lower for term in ("você", "como", "antes", "pare")):
        score += 7
    if len(title) > 85:
        score -= 15
    return round(max(0.0, min(100.0, score)), 2)
