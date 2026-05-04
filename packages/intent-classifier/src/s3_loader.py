"""Slice 56B: S3-backed model hot-reload.

Decouples the joblib artifact from the container image. The trainer
(packages/intent-classifier/training/train.py) uploads new artifacts to
S3 and updates a CURRENT.json pointer. This module polls that pointer
and swaps the in-memory model atomically when the version changes.

Layout in S3 (bucket = MODEL_S3_BUCKET, prefix = MODEL_S3_PREFIX):

    intent-classifier/CURRENT.json
        {"version": "v2-2026-05-04",
         "key":     "intent-classifier/v2-2026-05-04.joblib",
         "sha256":  "...",
         "trained_at": "2026-05-04T12:34:56Z"}

    intent-classifier/v1-2026-05-03.joblib
    intent-classifier/v2-2026-05-04.joblib
    ...

Why a CURRENT pointer instead of "newest by ListObjectsV2":
    - Atomic switch: trainer uploads the artifact FIRST, then updates the
      pointer. A reader that races between the two never sees the new
      version without a downloadable artifact.
    - Rollback: deploying an older version is just `aws s3 cp old-CURRENT
      s3://.../CURRENT.json` — no need to delete or rename artifacts.

Failure modes:
    - S3 unavailable on boot → fall back to image-baked artifact (or
      degraded mode). The poller keeps trying.
    - S3 unavailable mid-life → keep serving the loaded model. Log a
      warning per failed poll; clear when reachability returns.
    - Pointer references a missing key → log error, skip the swap, keep
      the prior model.
    - SHA256 mismatch on download → log error, skip the swap.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

import boto3
import joblib
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

logger = logging.getLogger("intent-classifier")


# ── Env config (with sensible local-dev defaults) ─────────────────────

_BUCKET   = os.environ.get("MODEL_S3_BUCKET",   "cip-platform-models")
_PREFIX   = os.environ.get("MODEL_S3_PREFIX",   "intent-classifier")
_INTERVAL = int(os.environ.get("MODEL_POLL_INTERVAL_SEC", "60"))
_ENDPOINT = os.environ.get("AWS_ENDPOINT_URL")  # OVH: https://s3.bhs.io.cloud.ovh.net
_REGION   = os.environ.get("AWS_REGION", "BHS")

CURRENT_KEY = f"{_PREFIX}/CURRENT.json"


@dataclass
class ModelPointer:
    version:    str
    key:        str
    sha256:     str
    trained_at: Optional[str] = None


def _client():
    """boto3 S3 client. Creds come from env (AWS_ACCESS_KEY_ID, etc.) —
    same wiring as the rest of the platform's S3 code."""
    return boto3.client(
        "s3",
        endpoint_url   = _ENDPOINT,
        region_name    = _REGION,
        config         = BotoConfig(
            signature_version = "s3v4",
            s3                = {"addressing_style": "path"},
            connect_timeout   = 5,
            read_timeout      = 30,
            retries           = {"max_attempts": 3, "mode": "standard"},
        ),
    )


def fetch_pointer() -> Optional[ModelPointer]:
    """GET CURRENT.json. Returns None on 404 or transport error."""
    try:
        s3 = _client()
        obj = s3.get_object(Bucket=_BUCKET, Key=CURRENT_KEY)
        body = obj["Body"].read()
        data = json.loads(body)
        return ModelPointer(
            version    = data["version"],
            key        = data["key"],
            sha256     = data["sha256"],
            trained_at = data.get("trained_at"),
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            logger.info("[s3_loader] no CURRENT pointer at s3://%s/%s — bucket may be uninitialised", _BUCKET, CURRENT_KEY)
            return None
        logger.warning("[s3_loader] CURRENT fetch failed: %s", e)
        return None
    except Exception:
        logger.exception("[s3_loader] CURRENT fetch unexpected error")
        return None


def download_artifact(pointer: ModelPointer) -> Optional[Path]:
    """Download to a temp file, verify SHA256, return the path. None on failure."""
    try:
        s3 = _client()
        # Stream into a hashing buffer so we don't trust the disk.
        buf = io.BytesIO()
        s3.download_fileobj(Bucket=_BUCKET, Key=pointer.key, Fileobj=buf)
        raw = buf.getvalue()
    except Exception:
        logger.exception("[s3_loader] download failed for %s", pointer.key)
        return None

    actual_sha = hashlib.sha256(raw).hexdigest()
    if actual_sha != pointer.sha256:
        logger.error(
            "[s3_loader] SHA256 mismatch for %s: pointer=%s actual=%s",
            pointer.key, pointer.sha256, actual_sha,
        )
        return None

    # Write to temp file (joblib.load can handle file-like or path; path
    # is more compatible with arbitrary picklers).
    tmp = tempfile.NamedTemporaryFile(suffix=".joblib", delete=False)
    tmp.write(raw)
    tmp.flush()
    tmp.close()
    return Path(tmp.name)


def load_bundle_from_path(path: Path) -> Optional[dict]:
    """Load a joblib bundle from disk. Returns the dict or None on failure."""
    try:
        bundle = joblib.load(path)
    except Exception:
        logger.exception("[s3_loader] joblib.load failed for %s", path)
        return None
    if not isinstance(bundle, dict) or "pipeline" not in bundle:
        logger.error("[s3_loader] %s is not a valid bundle (missing 'pipeline')", path)
        return None
    return bundle


# ── Poller ───────────────────────────────────────────────────────────

class S3ModelLoader:
    """Background asyncio task. Polls CURRENT.json every _INTERVAL
    seconds, swaps the model when the version changes."""

    def __init__(self, on_swap: Callable[[dict, str], None]):
        """on_swap is called with (bundle_dict, version) when a new
        artifact has been verified + loaded. The callback is responsible
        for the in-place state mutation (atomic from the caller's POV)."""
        self._on_swap        = on_swap
        self._task: Optional[asyncio.Task] = None
        self._loaded_version: Optional[str] = None
        self._stop_evt       = asyncio.Event()

    def set_loaded_version(self, version: Optional[str]) -> None:
        """Tell the poller what's currently loaded so it doesn't re-swap
        on the first poll. Called once after the initial image-baked
        load (or first S3 load) finishes."""
        self._loaded_version = version

    async def start(self) -> None:
        if self._task is not None:
            return
        # Initial check is immediate so the service can pick up a newer
        # S3 artifact before a slow 60s poll interval.
        await self._poll_once()
        self._task = asyncio.create_task(self._loop(), name="s3-model-poller")

    async def stop(self) -> None:
        self._stop_evt.set()
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
            self._task = None

    async def _loop(self) -> None:
        while not self._stop_evt.is_set():
            try:
                await asyncio.wait_for(self._stop_evt.wait(), timeout=_INTERVAL)
                # stop_evt fired; loop exits
                return
            except asyncio.TimeoutError:
                pass  # interval elapsed → poll
            await self._poll_once()

    async def _poll_once(self) -> None:
        # Run the (blocking) boto3 calls in a thread so the event loop
        # stays responsive to /classify requests.
        loop = asyncio.get_running_loop()
        pointer = await loop.run_in_executor(None, fetch_pointer)
        if pointer is None:
            return
        if pointer.version == self._loaded_version:
            return
        logger.info(
            "[s3_loader] new model detected: %s (loaded=%s) — downloading…",
            pointer.version, self._loaded_version,
        )
        path = await loop.run_in_executor(None, download_artifact, pointer)
        if path is None:
            return
        bundle = await loop.run_in_executor(None, load_bundle_from_path, path)
        try:
            path.unlink()
        except OSError:
            pass
        if bundle is None:
            return
        # Atomic swap from the caller's POV — predict() reads _state.pipeline
        # which is a single attribute write at the Python-level.
        try:
            self._on_swap(bundle, pointer.version)
            self._loaded_version = pointer.version
            logger.info("[s3_loader] swapped to %s", pointer.version)
        except Exception:
            logger.exception("[s3_loader] on_swap callback failed for %s", pointer.version)
