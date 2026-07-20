from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StorageObject(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    bucket: str = Field(min_length=3, max_length=255)
    key: str = Field(min_length=1, max_length=1024)
    version_id: Optional[str] = Field(None, alias="versionId", max_length=1024)

    @field_validator("key")
    @classmethod
    def valid_key(cls, value: str) -> str:
        if value.startswith("/") or "\x00" in value:
            raise ValueError("storage key is invalid")
        return value


class PipelineRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    schema_version: Literal[1] = Field(1, alias="schemaVersion")
    pipeline_run_id: str = Field(alias="pipelineRunId", min_length=8, max_length=128)
    stage_execution_id: str = Field(
        alias="stageExecutionId", min_length=8, max_length=128
    )
    video_id: str = Field(alias="videoId", min_length=8, max_length=128)
    source_uri: Optional[str] = Field(None, alias="sourceUri", max_length=8192)
    storage: Optional[StorageObject] = None
    force: bool = False
    options: Dict[str, Any] = Field(default_factory=dict)

    @field_validator("pipeline_run_id", "stage_execution_id", "video_id")
    @classmethod
    def safe_identifier(cls, value: str) -> str:
        if not all(character.isalnum() or character in "-_" for character in value):
            raise ValueError("identifier contains unsupported characters")
        return value


class ArtifactDescriptor(BaseModel):
    kind: str
    path: str
    sha256: str
    bytes: int
    media_type: str


class StageResponse(BaseModel):
    schema_version: Literal[1] = Field(1, alias="schemaVersion")
    pipeline_run_id: str = Field(alias="pipelineRunId")
    stage_execution_id: str = Field(alias="stageExecutionId")
    video_id: str = Field(alias="videoId")
    stage: str
    status: Literal["succeeded"] = "succeeded"
    cached: bool = False
    artifacts: List[ArtifactDescriptor]
    metrics: Dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(populate_by_name=True)


class SeoRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    transcript: str = Field(min_length=1, max_length=500_000)
    language: str = Field("pt", min_length=2, max_length=16)
    subject: Optional[str] = Field(None, max_length=200)
    audience: Optional[str] = Field(None, max_length=200)


class ReframeRequest(PipelineRequest):
    aspect_ratios: List[Literal["9:16", "1:1", "4:5", "16:9"]] = Field(
        default_factory=lambda: ["9:16"], alias="aspectRatios"
    )
    detector: Literal["opencv", "mediapipe", "yolo", "auto"] = "auto"


class CleanupWorkspacesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    pipeline_run_ids: List[str] = Field(
        alias="pipelineRunIds", min_length=1, max_length=500
    )

    @field_validator("pipeline_run_ids")
    @classmethod
    def safe_pipeline_run_ids(cls, values: List[str]) -> List[str]:
        for value in values:
            if len(value) < 8 or len(value) > 128 or not all(
                character.isalnum() or character in "-_" for character in value
            ):
                raise ValueError("pipeline run identifier contains unsupported characters")
        return list(dict.fromkeys(values))
