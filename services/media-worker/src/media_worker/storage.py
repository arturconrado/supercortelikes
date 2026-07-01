import mimetypes
from pathlib import Path
from typing import Any, Dict

from .config import Settings
from .errors import DependencyUnavailable, WorkerError


def upload_file(
    path: Path, bucket: str, key: str, settings: Settings
) -> Dict[str, Any]:
    if (
        not settings.s3_endpoint_url
        or not settings.s3_access_key_id
        or not settings.s3_secret_access_key
    ):
        raise WorkerError(
            "STORAGE_NOT_CONFIGURED",
            "S3/R2 export credentials are not configured",
            status_code=503,
        )
    try:
        import boto3
        from botocore.config import Config
    except ImportError as error:
        raise DependencyUnavailable(
            "boto3", "boto3 is required to export artifacts to S3/R2"
        ) from error
    client = boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint_url,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key_id,
        aws_secret_access_key=settings.s3_secret_access_key,
        config=Config(
            s3={"addressing_style": "path" if settings.s3_force_path_style else "auto"}
        ),
    )
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    try:
        client.upload_file(
            str(path), bucket, key, ExtraArgs={"ContentType": media_type}
        )
        metadata = client.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        raise WorkerError(
            "STORAGE_WRITE_FAILED",
            "Unable to export artifact to S3/R2",
            status_code=502,
        ) from error
    return {
        "bucket": bucket,
        "key": key,
        "etag": str(metadata.get("ETag", "")).strip('"'),
        "bytes": int(metadata.get("ContentLength", path.stat().st_size)),
        "mediaType": media_type,
    }
