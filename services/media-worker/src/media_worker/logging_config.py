import json
import logging
import re


_SECRET = re.compile(r"(Bearer\s+)[^\s]+|((?:password|secret|token|access_key)[=:]\s*)[^\s,]+", re.IGNORECASE)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        message = _SECRET.sub(lambda match: (match.group(1) or match.group(2) or "") + "[REDACTED]", record.getMessage())
        return json.dumps(
            {
                "level": record.levelname.lower(),
                "service": "media-worker",
                "logger": record.name,
                "message": message,
            },
            ensure_ascii=False,
        )


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    for name in ("media_worker", "uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(name)
        logger.handlers = [handler]
        logger.setLevel(level.upper())
        logger.propagate = False
