import json
import shutil
import subprocess
from typing import Any, List, Optional

from .errors import DependencyUnavailable, WorkerError


def require_binary(binary: str) -> str:
    resolved = shutil.which(binary)
    if resolved is None:
        raise DependencyUnavailable(
            binary,
            "Required executable is not installed or not present in PATH: %s" % binary,
        )
    return resolved


def run_command(
    command: List[str],
    *,
    timeout: Optional[int] = None,
    capture_json: bool = False,
) -> Any:
    if not command:
        raise ValueError("command cannot be empty")
    executable = require_binary(command[0])
    safe_command = [executable] + command[1:]
    try:
        result = subprocess.run(
            safe_command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise WorkerError(
            "PROCESS_TIMEOUT", "Media process exceeded its timeout", status_code=504
        ) from error
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace").strip()[-4000:]
        raise WorkerError(
            "MEDIA_PROCESS_FAILED",
            "%s exited with status %d: %s" % (command[0], result.returncode, stderr),
            detail={"executable": command[0], "exitCode": result.returncode},
        )
    if capture_json:
        try:
            return json.loads(result.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise WorkerError(
                "INVALID_PROCESS_OUTPUT", "%s returned invalid JSON" % command[0]
            ) from error
    return result.stdout
