"""Slice 56M: LLM-augmented training data from user documentation.

Reads markdown / text files, asks an LLM to propose user-question
phrasings that map to known tools, dedups against the existing corpus,
runs an LLM-as-judge second pass to drop low-confidence labels, and
inserts the survivors as `source='llm_augmented', is_synthetic=true,
reviewed=false` rows in bot_intent_training_data.

Anchored in: Cegin et al. 2024 — LLM augmentation "worthy of deployment
only when very small number of seeds is used." Beyond ~500 rows the
gains diminish + you start biasing toward LLM phrasing patterns.

Pipeline:
  1. Read doc files; split into ~1500-char chunks
  2. For each chunk: LLM-label → 5-10 (text, intent, tool) candidates
  3. Embedding-dedup vs existing corpus + each other (cosine > 0.9 dropped)
  4. LLM-judge: "does this phrase fit intent X?" — drop score < 0.7
  5. INSERT survivors with is_synthetic=true, reviewed=false

Cost discipline:
  - Different LLM family for augmentation than the bot's planner uses.
    Avoid training the classifier on the same model's biases that
    produce wrong-tool errors at runtime.
  - Cheap models (Haiku / Mistral-small / Mistral-nemo). Heavier models
    don't materially improve labeling quality at this corpus size.
  - One-time per doc set; rerun on docs change.

Usage (in-cluster, via the trainer pod or workstation):
    python -m training.augment_from_docs \\
      --docs ./user-docs/ \\
      --tenant-id 00000000-0000-0000-0000-000000000001 \\
      --max-per-chunk 8 \\
      --judge-threshold 0.7 \\
      [--dry-run]

Environment (same as the rest of the trainer):
    DATABASE_URL_HR / DATABASE_URL_HR_LOCAL
    LITELLM_BASE_URL  (for the LLM-label + LLM-judge calls)
    LITELLM_VIRTUAL_KEY
    AUG_LABEL_MODEL   (default: claude-haiku via cip-classifier alias)
    AUG_JUDGE_MODEL   (default: same; can split if you want different)
    AUG_EMBED_MODEL   (default: cip-embed via Mistral)
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import textwrap
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import psycopg

logger = logging.getLogger("augment")


# ── Tool catalog used in label prompts ────────────────────────────────
# Same hand-mapped tools as import_traces.py. Kept narrow on purpose;
# the LLM is constrained to label among known intents only.
TOOL_DESCRIPTIONS: dict[str, str] = {
    "employee_disable":         "Off-board / disable an employee account by name or email.",
    "employee_find":            "Look up an employee by email or name (returns identity row only).",
    "employee_list":            "List employees in the caller's tenant — paginated; supports active/disabled filters.",
    "get_employee_permissions": "Return the CALLING user's own roles + effective permissions. Self-only.",
    "get_my_certifications":    "Return the CALLING user's own certifications. Self-only.",
    "get_staff_certifications": "Return another employee's certifications (HR-only).",
}

OOS_INTENT = "out_of_scope"


# ── Env / connection helpers ─────────────────────────────────────────

def _pg_url() -> str:
    return (
        os.environ.get("DATABASE_URL_HR")
        or os.environ.get("DATABASE_URL_HR_LOCAL")
        or "postgresql://cipuser:"
           f"{os.environ.get('PG_USER_PASSWORD', '')}"
           "@localhost:15432/cip_hr"
    )


def _llm_chat(model: str, system: str, user: str, response_format: str = "text") -> str:
    """Call the bot's LiteLLM proxy. Returns the assistant message content
    as a string. Raises on non-2xx."""
    import requests
    base = os.environ.get("LITELLM_BASE_URL", "http://litellm.cip-app.svc.cluster.local:4000")
    key  = os.environ.get("LITELLM_VIRTUAL_KEY", "")
    body = {
        "model":    model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": user},
        ],
        "temperature": 0.3,
    }
    if response_format == "json":
        body["response_format"] = {"type": "json_object"}
    r = requests.post(
        f"{base}/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _llm_embed(text: str, model: str) -> list[float]:
    import requests
    base = os.environ.get("LITELLM_BASE_URL", "http://litellm.cip-app.svc.cluster.local:4000")
    key  = os.environ.get("LITELLM_VIRTUAL_KEY", "")
    r = requests.post(
        f"{base}/v1/embeddings",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": model, "input": text},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["data"][0]["embedding"]


def _cosine(a: list[float], b: list[float]) -> float:
    import math
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na > 0 and nb > 0 else 0.0


# ── Pipeline steps ────────────────────────────────────────────────────

def chunk_doc(text: str, target_chars: int = 1500) -> list[str]:
    """Split by markdown headings first; fall back to fixed-window split."""
    chunks: list[str] = []
    sections = []
    current: list[str] = []
    for line in text.splitlines(keepends=True):
        if line.startswith("#") and current:
            sections.append("".join(current))
            current = [line]
        else:
            current.append(line)
    if current:
        sections.append("".join(current))

    for sec in sections:
        if len(sec) <= target_chars:
            chunks.append(sec)
            continue
        # Long section — slice into target_chars windows on whitespace.
        i = 0
        while i < len(sec):
            j = min(i + target_chars, len(sec))
            # Snap to nearest whitespace if not at end.
            if j < len(sec):
                k = sec.rfind(" ", i, j)
                if k > i:
                    j = k
            chunks.append(sec[i:j])
            i = j
    return [c for c in chunks if c.strip()]


LABEL_PROMPT_SYSTEM = """\
You are a labeling assistant generating training examples for an intent
classifier. The classifier routes user messages to one of these tools:

{tool_lines}

Plus a special intent `out_of_scope` for off-topic / chitchat / questions
the bot can't answer.

Given a user-facing documentation snippet, propose user-question phrasings
that a real user might ask, each labelled with exactly ONE intent.

Rules:
- Use natural, conversational phrasings (varying length, with typos
  occasionally OK).
- Stay within the listed intents; do NOT invent new ones.
- Each phrasing must be ≤ 200 characters.
- If the doc is unrelated to any of the tools, output one or two
  out_of_scope examples to show what the doc IS about.
- Output JSON only, schema:
    {{"candidates": [{{"text": "...", "intent": "...", "tool": "..."}}]}}
- For out_of_scope rows, set tool to null."""


def llm_label_chunk(chunk: str, model: str, max_per_chunk: int) -> list[dict]:
    """Ask the LLM to propose `max_per_chunk` candidate (text, intent, tool)
    triples grounded in the chunk."""
    tool_lines = "\n".join(f"  - {name}: {desc}" for name, desc in TOOL_DESCRIPTIONS.items())
    system = LABEL_PROMPT_SYSTEM.format(tool_lines=tool_lines)
    user = textwrap.dedent(f"""\
        Documentation snippet:
        ---
        {chunk[:4000]}
        ---

        Propose up to {max_per_chunk} user-question phrasings.""")
    raw = _llm_chat(model, system, user, response_format="json")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("[label] non-JSON response, skipping chunk: %s", raw[:200])
        return []
    candidates = parsed.get("candidates", [])
    valid: list[dict] = []
    valid_intents = set(TOOL_DESCRIPTIONS) | {OOS_INTENT}
    # Map intent names that match the existing manual_examples taxonomy.
    intent_normalize = {
        "employee_disable":      "disable_employee",  # tool name → intent label
    }
    for c in candidates:
        text   = (c.get("text") or "").strip()
        intent = intent_normalize.get(c.get("intent") or "", c.get("intent") or "")
        tool   = c.get("tool") or None
        if not text or len(text) > 200:
            continue
        if intent not in valid_intents and intent != "disable_employee":
            continue
        valid.append({"text": text, "intent": intent, "tool": tool})
    return valid


JUDGE_PROMPT_SYSTEM = """\
You are a quality-control assistant for an intent-classifier training set.
For each (phrasing, intent) pair, judge whether the phrasing genuinely
maps to that intent. Return a confidence score in [0, 1] and a short
reason.

Output JSON only:
{"score": 0.0-1.0, "reason": "..."}"""


def llm_judge(text: str, intent: str, model: str) -> tuple[float, str]:
    user = f"Phrasing: {text!r}\nIntent: {intent}"
    raw = _llm_chat(model, JUDGE_PROMPT_SYSTEM, user, response_format="json")
    try:
        parsed = json.loads(raw)
        score  = float(parsed.get("score", 0.0))
        reason = str(parsed.get("reason", ""))
        return (max(0.0, min(1.0, score)), reason[:200])
    except (json.JSONDecodeError, ValueError, TypeError):
        return (0.0, "judge response unparseable")


# ── Database helpers ──────────────────────────────────────────────────

EXISTING_TEXTS_SQL = """
SELECT lower(text) FROM bot_intent_training_data
 WHERE tenant_id = %s
 ORDER BY added_at DESC LIMIT 5000
"""

INSERT_SQL = """
INSERT INTO bot_intent_training_data
  (tenant_id, added_by, text, intent, tool, next_action, source,
   predicted_intent, predicted_tool,
   is_synthetic, source_doc, source_doc_version, notes, reviewed)
VALUES
  (%s, 'augment_from_docs', %s, %s, %s,
   CASE WHEN %s = 'out_of_scope' THEN 'answer_directly' ELSE 'call_tool' END,
   'llm_augmented', %s, %s, true, %s, %s, %s, false)
"""


# ── Main ──────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description="Generate training data from user docs via LLM.")
    parser.add_argument("--docs", type=Path, required=True,
                        help="Path to a directory of .md / .txt docs OR a single doc file.")
    parser.add_argument("--tenant-id", type=str, required=True)
    parser.add_argument("--max-per-chunk", type=int, default=8)
    parser.add_argument("--judge-threshold", type=float, default=0.7)
    parser.add_argument("--dedup-cosine-cutoff", type=float, default=0.90)
    parser.add_argument("--label-model", type=str,
                        default=os.environ.get("AUG_LABEL_MODEL", "cip-classifier"))
    parser.add_argument("--judge-model", type=str,
                        default=os.environ.get("AUG_JUDGE_MODEL", "cip-classifier"))
    parser.add_argument("--embed-model", type=str,
                        default=os.environ.get("AUG_EMBED_MODEL", "cip-embed"))
    parser.add_argument("--source-doc-version", type=str,
                        default=datetime.now(timezone.utc).strftime("v%Y%m%d"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # Collect doc files.
    files: list[Path] = []
    if args.docs.is_file():
        files = [args.docs]
    elif args.docs.is_dir():
        for ext in ("*.md", "*.txt"):
            files.extend(args.docs.rglob(ext))
    if not files:
        print(f"ERROR: no .md/.txt files under {args.docs}", file=sys.stderr)
        return 1
    print(f"📄 {len(files)} doc files to process")

    # Pre-fetch existing-text embeddings for dedup.
    print("🔍 Fetching existing corpus for dedup…")
    with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(EXISTING_TEXTS_SQL, (args.tenant_id,))
            existing_texts = [row[0] for row in cur.fetchall()]
    print(f"   {len(existing_texts)} existing rows for the tenant")
    existing_embeddings: list[list[float]] = []
    if existing_texts:
        for t in existing_texts[:500]:  # cap embed-call cost
            try:
                existing_embeddings.append(_llm_embed(t, args.embed_model))
            except Exception as e:
                logger.warning("[embed] existing-row embed failed: %s", e)
        print(f"   embedded {len(existing_embeddings)} for dedup comparison")

    inserted = 0
    rejected_dedup = 0
    rejected_judge = 0
    seen_in_run: list[tuple[str, list[float]]] = []

    with psycopg.connect(_pg_url(), connect_timeout=10) as conn:
        for f in files:
            doc_name = str(f.relative_to(args.docs.parent if args.docs.is_dir() else args.docs))
            print(f"\n📄 {doc_name}")
            text = f.read_text(encoding="utf-8", errors="ignore")
            chunks = chunk_doc(text)
            print(f"   {len(chunks)} chunks")
            for ci, chunk in enumerate(chunks):
                candidates = llm_label_chunk(chunk, args.label_model, args.max_per_chunk)
                print(f"   chunk {ci+1}/{len(chunks)}: {len(candidates)} candidates")
                for cand in candidates:
                    text_l = cand["text"].lower()
                    # Cheap text-equality dedup first.
                    if text_l in (t for t in existing_texts):
                        rejected_dedup += 1
                        continue
                    # Embedding dedup vs existing + within-run.
                    cand_embed = None
                    try:
                        cand_embed = _llm_embed(cand["text"], args.embed_model)
                    except Exception as e:
                        logger.warning("[embed] candidate embed failed: %s", e)
                    if cand_embed:
                        too_close = False
                        for ex_emb in existing_embeddings:
                            if _cosine(cand_embed, ex_emb) >= args.dedup_cosine_cutoff:
                                too_close = True; break
                        if not too_close:
                            for (_, prior_emb) in seen_in_run:
                                if _cosine(cand_embed, prior_emb) >= args.dedup_cosine_cutoff:
                                    too_close = True; break
                        if too_close:
                            rejected_dedup += 1
                            continue
                    # LLM-as-judge.
                    score, reason = llm_judge(cand["text"], cand["intent"], args.judge_model)
                    if score < args.judge_threshold:
                        rejected_judge += 1
                        if args.dry_run:
                            print(f"     ⨯ judge={score:.2f} {cand['text']!r} → {cand['intent']} ({reason[:60]})")
                        continue
                    # Insert.
                    notes = f"doc:{doc_name} | chunk:{ci} | judge_score:{score:.2f} | reason:{reason[:80]}"
                    if args.dry_run:
                        print(f"     ✓ judge={score:.2f} {cand['text']!r} → {cand['intent']}")
                    else:
                        with conn.cursor() as cur:
                            cur.execute(INSERT_SQL, (
                                args.tenant_id, cand["text"], cand["intent"],
                                cand["tool"], cand["intent"],
                                cand["intent"], cand["tool"],
                                doc_name, args.source_doc_version, notes,
                            ))
                    inserted += 1
                    if cand_embed:
                        seen_in_run.append((cand["text"], cand_embed))
        if not args.dry_run:
            conn.commit()

    print()
    print(f"=== Augmentation summary ({'DRY RUN' if args.dry_run else 'WRITE'}) ===")
    print(f"  inserted:                {inserted}")
    print(f"  rejected (dedup):        {rejected_dedup}")
    print(f"  rejected (judge<{args.judge_threshold}): {rejected_judge}")
    print(f"  source_doc_version:      {args.source_doc_version}")
    if not args.dry_run and inserted > 0:
        print()
        print("Synthetic rows are tagged is_synthetic=true; eval.py excludes them")
        print("from holdout to keep regression checks honest. Sample 5-10% for")
        print("manual review with `make training-data-review`.")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sys.exit(main())
