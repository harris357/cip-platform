"""Slice 56B: trainer-side helpers for S3 + DB writes.

Called by train.py after a successful joblib.dump:
  1. ensure_bucket()             — idempotent CreateBucket
  2. upload_artifact()           — PutObject + verify
  3. update_current_pointer()    — atomic-ish swap of CURRENT.json
  4. record_model_run()          — INSERT bot_intent_model_runs
  5. record_membership()         — INSERT…SELECT bot_intent_training_membership

Failure of any DB step does NOT undo the S3 upload. The artifact is the
source of truth; the DB row is metadata. If the DB write fails, the
trainer logs the artifact URI + SHA so the operator can backfill.

Connection assumes a port-forward to the in-cluster postgres on
localhost:15432 (same pattern as scripts/training-data-export.sh).
Override via DATABASE_URL_HR_LOCAL.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import boto3
import psycopg
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError

logger = logging.getLogger("trainer")


# ── Env / config ──────────────────────────────────────────────────────

BUCKET   = os.environ.get("MODEL_S3_BUCKET",   "cip-platform-models")
PREFIX   = os.environ.get("MODEL_S3_PREFIX",   "intent-classifier")
ENDPOINT = os.environ.get("AWS_ENDPOINT_URL")  # OVH: https://s3.bhs.io.cloud.ovh.net
REGION   = os.environ.get("AWS_REGION", "BHS")

# Default to the same port-forward shape used by scripts/training-data-export.sh.
DEFAULT_PG_LOCAL = (
    "postgresql://cipuser:"
    f"{os.environ.get('PG_USER_PASSWORD', '')}"
    "@localhost:15432/cip_hr"
)


def _s3():
    return boto3.client(
        "s3",
        endpoint_url   = ENDPOINT,
        region_name    = REGION,
        config         = BotoConfig(
            signature_version = "s3v4",
            s3                = {"addressing_style": "path"},
            connect_timeout   = 5,
            read_timeout      = 60,
            retries           = {"max_attempts": 3, "mode": "standard"},
        ),
    )


def _pg_url() -> str:
    # Slice 56C: in-cluster trainer mounts hr-service-credentials which
    # provides DATABASE_URL_HR (cluster DNS). Workstation runs override
    # via DATABASE_URL_HR_LOCAL (typically a port-forward). The default
    # is the workstation port-forward shape so `make classifier-train`
    # works after `make forward`.
    return (
        os.environ.get("DATABASE_URL_HR")
        or os.environ.get("DATABASE_URL_HR_LOCAL")
        or DEFAULT_PG_LOCAL
    )


# ── S3 helpers ────────────────────────────────────────────────────────

def ensure_bucket() -> None:
    """Idempotent CreateBucket. OVH treats BucketAlreadyOwnedByYou as
    success; we tolerate both that and BucketAlreadyExists."""
    s3 = _s3()
    try:
        s3.create_bucket(Bucket=BUCKET)
        logger.info("[upload] created bucket %s", BUCKET)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
            return
        raise


def compute_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _scope_prefix(tenant_id: Optional[str]) -> str:
    """Slice 56D: per-tenant artifacts live under by-tenant/<id>/.
    Platform-wide artifacts live under the bare PREFIX."""
    if tenant_id:
        return f"{PREFIX}/by-tenant/{tenant_id}"
    return PREFIX


def upload_artifact(
    version: str, joblib_path: Path, tenant_id: Optional[str] = None,
) -> tuple[str, str]:
    """Upload the .joblib to S3. Returns (artifact_uri, sha256).

    Slice 56D: when tenant_id is set, the artifact lands under
    by-tenant/<id>/ so the classifier service can find it via
    fetch_pointer(tenant_id)."""
    sha = compute_sha256(joblib_path)
    scope = _scope_prefix(tenant_id)
    key = f"{scope}/{joblib_path.name}"
    s3 = _s3()
    s3.upload_file(
        Filename = str(joblib_path),
        Bucket   = BUCKET,
        Key      = key,
        ExtraArgs = {
            "ContentType": "application/octet-stream",
            "Metadata": {
                "version":   version,
                "sha256":    sha,
                **({"tenant_id": tenant_id} if tenant_id else {}),
            },
        },
    )
    uri = f"s3://{BUCKET}/{key}"
    logger.info("[upload] uploaded %s (sha256=%s)", uri, sha[:16])
    return uri, sha


def update_current_pointer(
    version: str, key: str, sha256: str, tenant_id: Optional[str] = None,
) -> None:
    """Write CURRENT.json — the pointer the classifier service polls.
    PutObject is atomic at the S3 level: readers see either the prior
    or the new pointer, never a partial.

    Slice 56D: when tenant_id is set, writes the per-tenant pointer at
    by-tenant/<id>/CURRENT.json instead of the platform-wide one."""
    body = json.dumps({
        "version":    version,
        "key":        key,
        "sha256":     sha256,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        **({"tenant_id": tenant_id} if tenant_id else {}),
    }).encode("utf-8")
    scope = _scope_prefix(tenant_id)
    _s3().put_object(
        Bucket       = BUCKET,
        Key          = f"{scope}/CURRENT.json",
        Body         = body,
        ContentType  = "application/json",
        CacheControl = "no-cache",
    )
    logger.info("[upload] updated %s/CURRENT.json → version=%s tenant=%s",
                scope, version, tenant_id or "platform")


# ── DB helpers ────────────────────────────────────────────────────────

def _git_head_sha() -> Optional[str]:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            check=True, capture_output=True, text=True, timeout=5,
        )
        return r.stdout.strip() or None
    except Exception:
        return None


def record_model_run(
    *,
    model_version:    str,
    corpus_cutoff_at: datetime,
    train_count:      int,
    intents_count:    int,
    cv_macro_f1:      Optional[float],
    holdout_macro_f1: Optional[float],
    artifact_uri:     str,
    artifact_sha256:  str,
    tenant_id:        Optional[str] = None,
    notes:            Optional[str] = None,
) -> Optional[str]:
    """INSERT one row into bot_intent_model_runs. Returns the new id, or
    None on conflict.

    Slice 56D: tenant_id NULL → platform-wide row; UUID → tenant-specific.
    Uniqueness is per-scope: same (tenant_id, model_version) raises
    conflict, but the same model_version can exist for different tenants.
    """
    sql = """
        INSERT INTO bot_intent_model_runs
            (tenant_id, model_version, corpus_cutoff_at, train_count, intents_count,
             cv_macro_f1, holdout_macro_f1, artifact_uri, artifact_sha256,
             trainer_git_sha, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        RETURNING id
    """
    params = (
        tenant_id, model_version, corpus_cutoff_at, train_count, intents_count,
        cv_macro_f1, holdout_macro_f1, artifact_uri, artifact_sha256,
        _git_head_sha(), notes,
    )
    try:
        with psycopg.connect(_pg_url(), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                conn.commit()
                if row is None:
                    logger.warning("[upload] model_version=%s tenant=%s already in bot_intent_model_runs — skipping membership",
                                   model_version, tenant_id or "platform")
                    return None
                return str(row[0])
    except Exception:
        logger.exception("[upload] failed to record model_run — artifact uploaded but DB lineage missing")
        return None


def record_membership(
    model_run_id: str, corpus_cutoff_at: datetime, tenant_id: Optional[str] = None,
) -> int:
    """Populate bot_intent_training_membership for the just-inserted run.
    INSERT…SELECT all reviewed rows whose added_at is on-or-before the
    cutoff. Returns row count.

    Slice 56D: when tenant_id is provided, restricts to that tenant's
    rows so the membership reflects what actually fed the per-tenant
    training (not all platform rows)."""
    sql = """
        INSERT INTO bot_intent_training_membership (model_run_id, training_data_id)
        SELECT %s, td.id
          FROM bot_intent_training_data td
         WHERE td.reviewed = true
           AND td.added_at <= %s
    """
    params: tuple = (model_run_id, corpus_cutoff_at)
    if tenant_id is not None:
        sql += " AND td.tenant_id = %s"
        params = (model_run_id, corpus_cutoff_at, tenant_id)
    sql += " ON CONFLICT DO NOTHING"
    try:
        with psycopg.connect(_pg_url(), connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
                count = cur.rowcount
                conn.commit()
                logger.info("[upload] recorded %d membership rows for run %s tenant=%s",
                            count, model_run_id[:8], tenant_id or "platform")
                return count
    except Exception:
        logger.exception("[upload] failed to record membership — manual backfill may be needed")
        return 0
