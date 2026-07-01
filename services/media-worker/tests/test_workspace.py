from pathlib import Path

import pytest

from media_worker.workspace import Workspace, file_sha256


def test_workspace_writes_json_atomically_and_hashes(tmp_path: Path):
    workspace = Workspace(tmp_path, "pipeline-123")
    path = workspace.write_json("output/value.json", {"ok": True})
    assert workspace.read_json("output/value.json") == {"ok": True}
    assert len(file_sha256(path)) == 64


def test_workspace_rejects_path_traversal(tmp_path: Path):
    workspace = Workspace(tmp_path, "pipeline-123")
    with pytest.raises(ValueError):
        workspace.path("../../escape")
