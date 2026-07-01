from typing import Optional


class WorkerError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status_code: int = 422,
        detail: Optional[dict] = None,
    ):
        super().__init__(message)
        self.code = code
        self.status_code = status_code
        self.detail = detail or {}


class DependencyUnavailable(WorkerError):
    def __init__(self, dependency: str, message: str):
        super().__init__(
            "DEPENDENCY_UNAVAILABLE",
            message,
            status_code=503,
            detail={"dependency": dependency},
        )


class ArtifactMissing(WorkerError):
    def __init__(self, artifact: str):
        super().__init__(
            "ARTIFACT_MISSING",
            "Required pipeline artifact is missing: %s" % artifact,
            status_code=409,
            detail={"artifact": artifact},
        )
