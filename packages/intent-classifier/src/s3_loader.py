"""Slice 56B + 56D: S3-backed model hot-reload, with per-tenant support.

Decouples the joblib artifact from the container image. The trainer
(packages/intent-classifier/training/train.py) uploads new artifacts to
S3 and updates a CURRENT.json pointer. This module polls those pointers
and swaps in-memory models atomically when the version changes.

Two scopes:
  - Platform (tenant_id=None) → s3://.../intent-classifier/CURRENT.json
  - Per-tenant (Slice 56D)    → s3://.../intent-classifier/by-tenant/<id>/CURRENT.json

Layout in S3 (bucket = MODEL_S3_BUCKET, prefix = MODEL_S3_PREFIX):

    intent-classifier/CURRENT.json
        {"version": "v2-2026-05-04",
         "key":     "intent-classifier/v2-2026-05-04.joblib",
         "sha256":  "...",
         "trained_at": "2026-05-04T12:34:56Z"}

    intent-classifier/v1-2026-05-03.joblib
    intent-classifier/v2-2026-05-04.joblib

    intent-classifier/by-tenant/<tenant-uuid>/CURRENT.json
    intent-classifier/by-tenant/<tenant-uuid>/<version>.joblib

Why a CURRENT pointer instead of "newest by ListObjectsV2":
    - Atomic switch: trainer uploads the artifact FIRST, then updates the
      pointer. A reader that races between the two never sees the new
      version without a downloadable artifact.
    - Rollback: deploying an older version is just `aws s3 cp old-CURRENT
      s3://.../CURRENT.json` — no need to delete or rename artifacts.

Failure modes (per scope):
    - S3 unavailable on boot → fall back to image-baked artifact (or
      degraded mode). The poller keeps trying.
    - S3 unavailable mid-life → keep serving the loaded model. Log a
      warning per failed poll; clear when reachability returns.
    - Pointer references a missing key → log error, skip the swap, keep
      the prior model.
    - SHA256 mismatch on download → log error, skip the swap.
    - Per-tenant pointer 404 → cache a "no model" sentinel for one poll
      cycle so /classify falls back to the platform model without
      hitting S3 every request.
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
from typing import Awaitable, Callable, Optional

import boto3
import joblib
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

logger = logging.getLogger("intent-classifier")


# ── Env config ───────────────────────────────────────────────────────

_BUCKET   = os.environ.get("MODEL_S3_BUCKET",   "cip-platform-models")
_PREFIX   = os.environ.get("MODEL_S3_PREFIX",   "intent-classifier")
_INTERVAL = int(os.environ.get("MODEL_POLL_INTERVAL_SEC", "60"))
_ENDPOINT = os.environ.get("AWS_ENDPOINT_URL")  # OVH: https://s3.bhs.io.cloud.ovh.net
_REGION   = os.environ.get("AWS_REGION", "BHS")
PER_TENANT_ENABLED = os.environ.get("CLASSIFIER_PER_TENANT_ENABLED", "false").lower() == "true"


def _scope_prefix(tenant_id: Optional[str]) -> str:
    if tenant_id:
        return f"{_PREFIX}/by-tenant/{tenant_id}"
    return _PREFIX


def _current_key(tenant_id: Optional[str]) -> str:
    return f"{_scope_prefix(tenant_id)}/CURRENT.json"


@dataclass
class ModelPointer:
    version:    str
    key:        str
    sha256:     str
    tenant_id:  Optional[str] = None
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


def fetch_pointer(tenant_id: Optional[str] = None) -> Optional[ModelPointer]:
    """GET CURRENT.json for the given scope. Returns None on 404 or transport error."""
    key = _current_key(tenant_id)
    try:
        s3 = _client()
        obj = s3.get_object(Bucket=_BUCKET, Key=key)
        body = obj["Body"].read()
        data = json.loads(body)
        return ModelPointer(
            version    = data["version"],
            key        = data["key"],
            sha256     = data["sha256"],
            tenant_id  = tenant_id,
            trained_at = data.get("trained_at"),
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        if code in ("NoSuchKey", "404"):
            scope = tenant_id or "platform"
            logger.info("[s3_loader] no CURRENT pointer at s3://%s/%s — scope=%s",
                        _BUCKET, key, scope)
            return None
        logger.warning("[s3_loader] CURRENT fetch failed (scope=%s): %s",
                       tenant_id or "platform", e)
        return None
    except Exception:
        logger.exception("[s3_loader] CURRENT fetch unexpected error (scope=%s)",
                         tenant_id or "platform")
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

# Sentinel: a tenant we've checked but doesn't have a per-tenant model
# in S3. Cached for one poll interval so /classify falls back to the
# platform model without re-fetching every request.
_NO_MODEL_FOR_TENANT = "__NO_MODEL__"


SwapCallback = Callable[[dict, str, Optional[str]], None]


class S3ModelLoader:
    """Background asyncio task. Polls CURRENT.json (platform + every
    known tenant) every _INTERVAL seconds, swaps the model when the
    version changes.

    Slice 56D: tenant_ids are registered lazily — the first /classify
    request for a tenant calls register_tenant(tenant_id), which kicks
    a one-shot fetch. From then on the periodic poller refreshes that
    tenant alongside the platform pointer.
    """

    def __init__(self, on_swap: SwapCallback):
        """on_swap is called with (bundle_dict, version, tenant_id)
        when a new artifact has been verified + loaded. tenant_id=None
        means the platform-wide model."""
        self._on_swap         = on_swap
        self._task: Optional[asyncio.Task] = None
        self._loaded: dict[Optional[str], str] = {}  # scope → loaded version OR sentinel
        self._tenants: set[str] = set()
        self._stop_evt        = asyncio.Event()
        self._registry_lock   = asyncio.Lock()

    def set_loaded_version(self, version: Optional[str], tenant_id: Optional[str] = None) -> None:
        """Record the currently-loaded version for a scope so the poller
        skips the redundant initial swap."""
        if version:
            self._loaded[tenant_id] = version

    async def register_tenant(self, tenant_id: str) -> bool:
        """Slice 56D: called by the service on first /classify miss for
        a tenant. Returns True if a model was successfully loaded for
        this tenant; False if no per-tenant model exists (caller falls
        back to platform)."""
        async with self._registry_lock:
            if tenant_id in self._tenants:
                return self._loaded.get(tenant_id) not in (None, _NO_MODEL_FOR_TENANT)
            self._tenants.add(tenant_id)
        # Outside the lock — the fetch may take a few hundred ms.
        await self._poll_scope(tenant_id)
        loaded = self._loaded.get(tenant_id)
        return loaded not in (None, _NO_MODEL_FOR_TENANT)

    async def start(self) -> None:
        if self._task is not None:
            return
        # Initial check is immediate so the service can pick up a newer
        # S3 artifact before a slow 60s poll interval.
        await self._poll_scope(None)
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
            await self._poll_scope(None)
            # Snapshot the tenant set so concurrent register_tenant() calls
            # don't mutate while we're iterating.
            tenants = list(self._tenants)
            for t in tenants:
                await self._poll_scope(t)

    async def _poll_scope(self, tenant_id: Optional[str]) -> None:
        # Run the (blocking) boto3 calls in a thread so the event loop
        # stays responsive to /classify requests.
        loop = asyncio.get_running_loop()
        pointer = await loop.run_in_executor(None, fetch_pointer, tenant_id)
        if pointer is None:
            # No pointer for this scope.
            if tenant_id is not None and self._loaded.get(tenant_id) is None:
                # First fetch of this tenant came up empty — cache the
                # sentinel so we don't re-fetch on every /classify until
                # the next poll cycle clears it.
                self._loaded[tenant_id] = _NO_MODEL_FOR_TENANT
            return
        # If we previously cached the negative sentinel, clear it so the
        # version comparison below works.
        if self._loaded.get(tenant_id) == _NO_MODEL_FOR_TENANT:
            self._loaded.pop(tenant_id, None)
        if pointer.version == self._loaded.get(tenant_id):
            return
        scope = tenant_id or "platform"
        logger.info(
            "[s3_loader] new model detected (scope=%s): %s (loaded=%s) — downloading…",
            scope, pointer.version, self._loaded.get(tenant_id),
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
        try:
            self._on_swap(bundle, pointer.version, tenant_id)
            self._loaded[tenant_id] = pointer.version
            logger.info("[s3_loader] swapped to %s (scope=%s)", pointer.version, scope)
        except Exception:
            logger.exception("[s3_loader] on_swap callback failed for %s scope=%s",
                             pointer.version, scope)
