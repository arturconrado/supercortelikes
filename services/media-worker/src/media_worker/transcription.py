from pathlib import Path
from typing import Any, Dict, List

from .config import Settings
from .errors import DependencyUnavailable, WorkerError
from .memory import release_runtime_memory


def transcribe(
    path: Path, settings: Settings, options: Dict[str, Any]
) -> Dict[str, Any]:
    try:
        import whisperx
    except ImportError as error:
        raise DependencyUnavailable(
            "whisperx",
            "WhisperX is required for transcription; install requirements-ai.txt in the worker image",
        ) from error

    device = str(options.get("device", settings.whisper_device))
    compute_type = str(options.get("computeType", settings.whisper_compute_type))
    model_name = str(options.get("model", settings.whisper_model))
    batch_size = int(options.get("batchSize", 16))
    language = options.get("language")
    diarize = bool(options.get("diarize", settings.diarization_enabled))
    audio = None
    model = None
    raw = None
    align_model = None
    align_metadata = None
    aligned = None
    diarizer = None
    diarized = None
    aligned_segments: List[Dict[str, Any]] = []
    detected_language = language or "unknown"
    if diarize and not settings.hf_token:
        raise WorkerError(
            "HF_TOKEN_REQUIRED",
            "HF_TOKEN is required for Pyannote speaker diarization",
            status_code=503,
        )
    try:
        audio = whisperx.load_audio(str(path))
        model = whisperx.load_model(
            model_name, device, compute_type=compute_type, language=language
        )
        raw = model.transcribe(audio, batch_size=batch_size, language=language)
        detected_language = raw.get("language") or language or "unknown"
        align_model, align_metadata = whisperx.load_align_model(
            language_code=detected_language, device=device
        )
        aligned = whisperx.align(
            raw["segments"],
            align_model,
            align_metadata,
            audio,
            device,
            return_char_alignments=False,
        )
        if diarize:
            try:
                from whisperx.diarize import DiarizationPipeline
            except ImportError:
                DiarizationPipeline = whisperx.DiarizationPipeline
            diarizer = DiarizationPipeline(
                use_auth_token=settings.hf_token, device=device
            )
            diarized = diarizer(
                audio,
                min_speakers=_optional_int(options.get("minSpeakers")),
                max_speakers=_optional_int(options.get("maxSpeakers")),
            )
            aligned = whisperx.assign_word_speakers(diarized, aligned)
        aligned_segments = list(aligned.get("segments", []))
    except WorkerError:
        raise
    except Exception as error:
        raise WorkerError(
            "TRANSCRIPTION_FAILED",
            "WhisperX transcription failed: %s" % _safe_exception(error),
            status_code=502,
        ) from error
    finally:
        del audio, model, raw, align_model, align_metadata, aligned, diarizer, diarized
        release_runtime_memory()
    segments = [
        _normalize_segment(index, value)
        for index, value in enumerate(aligned_segments)
    ]
    if not segments:
        raise WorkerError("TRANSCRIPT_EMPTY", "WhisperX returned no speech segments")
    confidence_values = [
        word["confidence"]
        for segment in segments
        for word in segment["words"]
        if word["confidence"] is not None
    ]
    confidence = (
        sum(confidence_values) / len(confidence_values) if confidence_values else 0.0
    )
    return {
        "engine": "whisperx",
        "model": model_name,
        "language": detected_language,
        "confidence": round(confidence, 5),
        "durationSeconds": max(segment["end"] for segment in segments),
        "speakerCount": len(
            {segment["speaker"] for segment in segments if segment["speaker"]}
        ),
        "segments": segments,
    }


def _normalize_segment(index: int, segment: Dict[str, Any]) -> Dict[str, Any]:
    words: List[Dict[str, Any]] = []
    for value in segment.get("words", []):
        if "start" not in value or "end" not in value:
            continue
        words.append(
            {
                "word": str(value.get("word", "")).strip(),
                "start": round(float(value["start"]), 3),
                "end": round(float(value["end"]), 3),
                "confidence": _optional_float(value.get("score")),
                "speaker": value.get("speaker") or segment.get("speaker"),
            }
        )
    return {
        "id": index,
        "start": round(
            float(segment.get("start", words[0]["start"] if words else 0)), 3
        ),
        "end": round(float(segment.get("end", words[-1]["end"] if words else 0)), 3),
        "text": str(segment.get("text", "")).strip(),
        "speaker": segment.get("speaker"),
        "words": words,
    }


def _optional_float(value: Any) -> Any:
    return None if value is None else round(float(value), 5)


def _optional_int(value: Any) -> Any:
    return None if value is None else int(value)


def _safe_exception(error: Exception) -> str:
    return str(error).replace("\n", " ").replace("\r", " ")[:500]

