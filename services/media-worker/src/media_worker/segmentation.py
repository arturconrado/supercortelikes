import re
from pathlib import Path
from typing import Any, Dict, List, Sequence, Set


TOKEN_PATTERN = re.compile(r"[\wÀ-ÿ]+", re.UNICODE)
EMOTIONS = {
    "joy": {
        "alegria",
        "feliz",
        "incrível",
        "maravilhoso",
        "sucesso",
        "amor",
        "ganhar",
        "conquista",
    },
    "surprise": {
        "surpresa",
        "chocante",
        "ninguém",
        "segredo",
        "inesperado",
        "descobri",
        "revelar",
    },
    "anger": {"raiva", "absurdo", "injusto", "ódio", "revoltante", "erro", "mentira"},
    "fear": {"medo", "risco", "perigo", "preocupado", "crise", "perder", "ameaça"},
    "sadness": {"triste", "perda", "fracasso", "dor", "difícil", "desistir"},
}
STOPWORDS = {
    "a",
    "as",
    "o",
    "os",
    "de",
    "da",
    "do",
    "das",
    "dos",
    "e",
    "em",
    "um",
    "uma",
    "que",
    "para",
    "por",
    "com",
    "não",
    "na",
    "no",
    "se",
    "é",
    "ao",
    "ou",
    "como",
    "mais",
    "the",
    "and",
    "to",
    "of",
}


def semantic_segments(
    transcript_segments: Sequence[Dict[str, Any]],
    *,
    silence_threshold: float = 1.2,
    topic_similarity_threshold: float = 0.12,
    target_duration: float = 28.0,
    max_duration: float = 55.0,
) -> List[Dict[str, Any]]:
    if not transcript_segments:
        return []
    groups: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    reasons: Set[str] = set()
    group_reasons: List[List[str]] = []
    for item in transcript_segments:
        item = dict(item)
        if not current:
            current.append(item)
            continue
        previous = current[-1]
        gap = max(0.0, float(item["start"]) - float(previous["end"]))
        duration = float(item["end"]) - float(current[0]["start"])
        speaker_changed = bool(
            item.get("speaker")
            and previous.get("speaker")
            and item["speaker"] != previous["speaker"]
        )
        similarity = lexical_similarity(previous.get("text", ""), item.get("text", ""))
        hard_boundary = gap >= silence_threshold or duration >= max_duration
        soft_boundary = duration >= target_duration and (
            speaker_changed or similarity < topic_similarity_threshold
        )
        if hard_boundary or soft_boundary:
            if gap >= silence_threshold:
                reasons.add("silence")
            if duration >= max_duration:
                reasons.add("max_duration")
            if speaker_changed:
                reasons.add("speaker_change")
            if similarity < topic_similarity_threshold:
                reasons.add("topic_change")
            groups.append(current)
            group_reasons.append(sorted(reasons) or ["semantic_pause"])
            current = [item]
            reasons = set()
        else:
            current.append(item)
    groups.append(current)
    group_reasons.append(sorted(reasons) or ["end_of_transcript"])
    return [
        _build_segment(index, values, group_reasons[index])
        for index, values in enumerate(groups)
    ]


def visual_segments(
    path: Path,
    duration_seconds: float,
    *,
    target_duration: float = 28.0,
    max_duration: float = 55.0,
) -> List[Dict[str, Any]]:
    """Build highlight candidates for media without speech.

    Samples frames instead of decoding the complete source. Boundaries favor scene
    changes and motion; the deterministic time-window fallback keeps valid videos
    processable when OpenCV or a decoder is unavailable.
    """
    duration = max(0.0, float(duration_seconds))
    if duration <= 0:
        return []
    target = max(3.0, min(float(target_duration), float(max_duration)))
    boundaries = [0.0]
    signals: Dict[float, Dict[str, float]] = {}
    try:
        import cv2  # type: ignore

        capture = cv2.VideoCapture(str(path))
        sample_step = max(0.5, min(2.0, duration / 120.0))
        previous_gray = None
        previous_hist = None
        timestamp = 0.0
        while timestamp < duration:
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = capture.read()
            if not ok:
                timestamp += sample_step
                continue
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            gray = cv2.resize(gray, (160, 90))
            histogram = cv2.calcHist([gray], [0], None, [32], [0, 256])
            cv2.normalize(histogram, histogram)
            scene = 0.0 if previous_hist is None else float(
                cv2.compareHist(previous_hist, histogram, cv2.HISTCMP_BHATTACHARYYA)
            )
            motion = 0.0 if previous_gray is None else float(
                cv2.absdiff(previous_gray, gray).mean() / 255.0
            )
            sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())
            signals[round(timestamp, 3)] = {
                "scene": round(scene, 4),
                "motion": round(motion, 4),
                "sharpness": round(sharpness, 2),
            }
            elapsed = timestamp - boundaries[-1]
            if elapsed >= target and (scene >= 0.28 or elapsed >= max_duration):
                boundaries.append(timestamp)
            previous_gray, previous_hist = gray, histogram
            timestamp += sample_step
        capture.release()
    except BaseException:
        signals = {}

    while duration - boundaries[-1] > max_duration:
        boundaries.append(min(duration, boundaries[-1] + target))
    if duration - boundaries[-1] >= 3.0:
        boundaries.append(duration)
    elif len(boundaries) == 1:
        boundaries.append(duration)
    else:
        boundaries[-1] = duration

    segments = []
    for index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        samples = [value for at, value in signals.items() if start <= at < end]
        visual_score = 50.0
        if samples:
            scene = sum(value["scene"] for value in samples) / len(samples)
            motion = sum(value["motion"] for value in samples) / len(samples)
            sharpness = sum(value["sharpness"] for value in samples) / len(samples)
            visual_score = min(100.0, 35.0 + scene * 55.0 + motion * 80.0 + min(20.0, sharpness / 25.0))
        segments.append({
            "id": index,
            "start": round(start, 3),
            "end": round(end, 3),
            "text": "",
            "speakers": [],
            "boundaryReasons": ["visual_change" if signals else "time_window"],
            "emotion": {"label": "neutral", "confidence": 0.5},
            "transcriptSegmentIds": [],
            "visualScore": round(visual_score, 2),
            "processingMode": "visual",
        })
    return segments


def lexical_similarity(left: str, right: str) -> float:
    left_tokens = token_set(left)
    right_tokens = token_set(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def token_set(text: str) -> Set[str]:
    return {
        token
        for token in TOKEN_PATTERN.findall(text.lower())
        if token not in STOPWORDS and len(token) > 1
    }


def dominant_emotion(text: str) -> Dict[str, Any]:
    tokens = token_set(text)
    matches = {emotion: len(tokens & words) for emotion, words in EMOTIONS.items()}
    emotion, count = max(matches.items(), key=lambda value: value[1])
    if count == 0:
        return {"label": "neutral", "confidence": 0.5}
    confidence = min(1.0, 0.5 + count / max(4.0, len(tokens) ** 0.5 * 4.0))
    return {"label": emotion, "confidence": round(confidence, 4)}


def _build_segment(
    index: int, values: Sequence[Dict[str, Any]], reasons: List[str]
) -> Dict[str, Any]:
    text = " ".join(str(value.get("text", "")).strip() for value in values).strip()
    speakers = list(
        dict.fromkeys(value.get("speaker") for value in values if value.get("speaker"))
    )
    return {
        "id": index,
        "start": round(float(values[0]["start"]), 3),
        "end": round(float(values[-1]["end"]), 3),
        "text": text,
        "speakers": speakers,
        "boundaryReasons": reasons,
        "emotion": dominant_emotion(text),
        "transcriptSegmentIds": [
            value.get("id", item_index) for item_index, value in enumerate(values)
        ],
    }
