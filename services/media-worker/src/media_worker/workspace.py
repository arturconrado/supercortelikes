import hashlib
import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, Iterator, List

from .errors import ArtifactMissing
from .models import ArtifactDescriptor


class Workspace:
    def __init__(self, root: Path, pipeline_run_id: str):
        self.root = (root / pipeline_run_id).resolve()
        expected_parent = root.resolve()
        if expected_parent not in self.root.parents:
            raise ValueError("Pipeline workspace escapes the configured data directory")
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, relative: str) -> Path:
        candidate = (self.root / relative).resolve()
        if self.root != candidate and self.root not in candidate.parents:
            raise ValueError("Artifact path escapes pipeline workspace")
        return candidate

    def require(self, relative: str) -> Path:
        value = self.path(relative)
        if not value.is_file():
            raise ArtifactMissing(relative)
        return value

    def read_json(self, relative: str) -> Any:
        with self.require(relative).open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def write_json(self, relative: str, value: Any) -> Path:
        target = self.path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=".artifact-", dir=str(target.parent)
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, target)
        except BaseException:
            Path(temporary_name).unlink(missing_ok=True)
            raise
        return target

    def result_path(self, stage: str) -> Path:
        return self.path("results/%s.json" % stage)

    def load_result(self, stage: str) -> Dict[str, Any]:
        with self.result_path(stage).open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def has_result(self, stage: str) -> bool:
        return self.result_path(stage).is_file()

    def save_result(self, stage: str, value: Dict[str, Any]) -> None:
        self.write_json("results/%s.json" % stage, value)

    @contextmanager
    def stage_lock(self, stage: str) -> Iterator[None]:
        import fcntl

        lock_path = self.path("locks/%s.lock" % stage)
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(chunk_size)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def artifact(path: Path, kind: str, media_type: str) -> ArtifactDescriptor:
    return ArtifactDescriptor(
        kind=kind,
        path=str(path),
        sha256=file_sha256(path),
        bytes=path.stat().st_size,
        media_type=media_type,
    )


def artifacts_to_dict(values: List[ArtifactDescriptor]) -> List[Dict[str, Any]]:
    return [value.model_dump(mode="json", exclude_none=True) for value in values]
