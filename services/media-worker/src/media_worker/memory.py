import ctypes
import gc
import sys


def release_runtime_memory() -> None:
    """Best-effort cleanup for native ML runtimes after heavy media stages.

    WhisperX/PyTorch, OpenCV, MediaPipe and ffmpeg wrappers can leave large native
    arenas allocated after Python objects are collected. In the release/demo
    worker we run serially in a 2 GB container, so returning free arenas to the
    OS is part of the readiness contract rather than an optimization.
    """

    try:
        gc.collect()
    except BaseException:
        pass

    try:
        import torch

        if hasattr(torch, "cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()
        mps = getattr(torch, "mps", None)
        if mps is not None and hasattr(mps, "empty_cache"):
            mps.empty_cache()
    except BaseException:
        pass

    if sys.platform.startswith("linux"):
        try:
            ctypes.CDLL("libc.so.6").malloc_trim(0)
        except BaseException:
            pass
