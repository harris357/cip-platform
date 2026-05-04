"""Slice 56N: /admin/run-* endpoints for the RetrainModelWorkflow.

The Temporal workflow lives in hr-service; its activities call BACK to
this service via HTTP to invoke the existing Python scripts (export,
train, eval, upload). This keeps the Python code as the single source
of truth for ML logic — we don't reimplement train/eval in TypeScript.

Each endpoint shells out to the corresponding `python -m training.X`
module via subprocess and returns the structured result. Subprocess
boundary is intentional — gives the activity layer a clean
"succeeded / failed with stderr" contract without us having to import
the trainer modules into the request thread.

These endpoints are gated by being on the cluster-internal service URL
only (no ingress route). hr-service workers in the same namespace can
hit them; nothing else can.
"""

from __future__ import annotations
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger("intent-classifier.admin")

router = APIRouter(prefix="/admin", tags=["admin"])


# ── Subprocess runner ─────────────────────────────────────────────────

def _run(args: list[str], timeout: int) -> tuple[str, str, int]:
    """Run a python -m … subprocess. Returns (stdout, stderr, returncode)."""
    logger.info("[admin] subprocess: %s", " ".join(args))
    p = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd="/app",
    )
    return p.stdout, p.stderr, p.returncode


# ── Request / response models ─────────────────────────────────────────

class TraceImportRequest(BaseModel):
    tenant_id: Optional[str] = None
    days:      int = Field(default=7,   ge=1, le=90)
    limit:     int = Field(default=500, ge=1, le=5000)


class TraceImportResponse(BaseModel):
    inserted: int
    skipped:  int


class ExportRequest(BaseModel):
    tenant_id: Optional[str] = None


class ExportResponse(BaseModel):
    csvPath:  str
    rowCount: int


class TrainRequest(BaseModel):
    tenant_id: Optional[str] = None
    csv_path:  str
    version:   str


class TrainResponse(BaseModel):
    artifactPath:   str
    version:        str
    cvMacroF1:      Optional[float]
    intentsCount:   int
    corpusCutoffAt: str


class EvalRequest(BaseModel):
    tenant_id:        Optional[str] = None
    csv_path:         str
    candidate_path:   str
    min_improvement:  float = 0.01
    max_regression:   float = 0.05


class EvalResponse(BaseModel):
    passed:        bool
    candidateF1:   float
    baselineF1:    Optional[float]
    reason:        Optional[str]


class UploadRequest(BaseModel):
    tenant_id:     Optional[str] = None
    artifact_path: str
    version:       str


class UploadResponse(BaseModel):
    artifactUri:    str
    artifactSha256: str


# ── Endpoints ─────────────────────────────────────────────────────────

@router.post("/run-trace-import", response_model=TraceImportResponse)
def run_trace_import(req: TraceImportRequest):
    args = ["python", "-m", "training.import_traces",
            "--days", str(req.days), "--limit", str(req.limit)]
    if req.tenant_id:
        args.extend(["--tenant-id", req.tenant_id])
    stdout, stderr, rc = _run(args, timeout=300)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"import_traces failed: {stderr[-500:]}")
    # The script prints "inserted: N" and "skipped (dedup): N" lines —
    # parse them. v2 should make import_traces emit JSON.
    inserted = 0
    skipped  = 0
    for line in stdout.splitlines():
        if line.strip().startswith("inserted:"):
            try: inserted = int(line.split(":")[1].strip())
            except ValueError: pass
        elif "skipped" in line:
            try: skipped += int(line.split(":")[1].strip())
            except (ValueError, IndexError): pass
    return TraceImportResponse(inserted=inserted, skipped=skipped)


@router.post("/run-export", response_model=ExportResponse)
def run_export(req: ExportRequest):
    csv_path = "/tmp/training_data.csv"
    args = ["python", "-m", "training.export_training_data",
            "--csv-in", "/app/training/manual_examples.csv",
            "--csv-out", csv_path]
    if req.tenant_id:
        args.extend(["--tenant-id", req.tenant_id])
    stdout, stderr, rc = _run(args, timeout=120)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"export failed: {stderr[-500:]}")
    # Count rows in the produced CSV (subtract 1 for header).
    row_count = 0
    p = Path(csv_path)
    if p.exists():
        with p.open() as fh:
            row_count = max(0, sum(1 for _ in fh) - 1)
    return ExportResponse(csvPath=csv_path, rowCount=row_count)


@router.post("/run-train", response_model=TrainResponse)
def run_train(req: TrainRequest):
    out_dir = "/tmp/models"
    args = ["python", "-m", "training.train",
            "--csv", req.csv_path,
            "--out-dir", out_dir,
            "--version", req.version,
            "--no-upload"]   # workflow handles upload separately
    if req.tenant_id:
        args.extend(["--tenant-id", req.tenant_id])
    stdout, stderr, rc = _run(args, timeout=1800)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"train failed: {stderr[-500:]}")
    artifact_path = f"{out_dir}/classifier-{req.version}.joblib"
    if not Path(artifact_path).exists():
        raise HTTPException(status_code=500, detail=f"train completed but {artifact_path} missing")
    # Parse cv_macro_f1 from stdout.
    cv_f1 = None
    intents_count = 0
    for line in stdout.splitlines():
        if "Cross-val" in line and "macro F1" in line:
            try: cv_f1 = float(line.split("mean=")[1].split()[0])
            except (ValueError, IndexError): pass
        if "intents:" in line.lower():
            try: intents_count = int(line.split(":")[1].split()[0])
            except (ValueError, IndexError): pass
    from datetime import datetime, timezone
    return TrainResponse(
        artifactPath=artifact_path,
        version=req.version,
        cvMacroF1=cv_f1,
        intentsCount=intents_count,
        corpusCutoffAt=datetime.now(timezone.utc).isoformat(),
    )


@router.post("/run-eval", response_model=EvalResponse)
def run_eval(req: EvalRequest):
    # eval.py only takes --csv + --baseline; candidate is built from CSV.
    # The candidate_path from the train step is informational here (we
    # could later add an arg to eval.py to use it directly; for v1 we
    # rely on eval.py's own candidate-from-csv behavior).
    args = ["python", "-m", "training.eval",
            "--csv", req.csv_path,
            "--min-improvement", str(req.min_improvement),
            "--max-regression",  str(req.max_regression)]
    # If a baseline exists at the conventional path, pass it. Otherwise
    # eval.py will skip the regression gate (first-train path).
    baseline_path = "/tmp/baseline.joblib"
    if Path(baseline_path).exists():
        args.extend(["--baseline", baseline_path])
    stdout, stderr, rc = _run(args, timeout=300)
    candidate_f1 = 0.0
    baseline_f1: Optional[float] = None
    reason: Optional[str] = None
    for line in stdout.splitlines():
        if "Candidate macro F1" in line:
            try: candidate_f1 = float(line.split(":")[1].strip())
            except (ValueError, IndexError): pass
        if "Baseline macro F1" in line:
            try: baseline_f1 = float(line.split(":")[1].strip())
            except (ValueError, IndexError): pass
        if "GATE FAILED" in line:
            reason = line
    passed = rc == 0
    if not passed and reason is None:
        reason = stderr[-200:] or "eval failed (no specific reason captured)"
    return EvalResponse(
        passed=passed,
        candidateF1=candidate_f1,
        baselineF1=baseline_f1,
        reason=reason,
    )


@router.post("/run-upload", response_model=UploadResponse)
def run_upload(req: UploadRequest):
    # Use upload.py's helpers directly via a small inline subprocess.
    # Easier than parsing train.py's compound output.
    code = f"""
import json, sys
from training.upload import ensure_bucket, upload_artifact, update_current_pointer
ensure_bucket()
uri, sha = upload_artifact({req.version!r}, __import__('pathlib').Path({req.artifact_path!r}), tenant_id={req.tenant_id!r})
key = uri.split('/', 3)[-1]
update_current_pointer({req.version!r}, key, sha, tenant_id={req.tenant_id!r})
print(json.dumps({{"artifactUri": uri, "artifactSha256": sha}}))
"""
    args = ["python", "-c", code]
    stdout, stderr, rc = _run(args, timeout=300)
    if rc != 0:
        raise HTTPException(status_code=500, detail=f"upload failed: {stderr[-500:]}")
    last_json = next((line for line in reversed(stdout.splitlines()) if line.strip().startswith("{")), None)
    if not last_json:
        raise HTTPException(status_code=500, detail=f"upload returned no JSON: {stdout[-500:]}")
    parsed = json.loads(last_json)
    return UploadResponse(**parsed)
