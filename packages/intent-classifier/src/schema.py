"""Slice 56: pydantic request/response shapes for the classifier service."""

from typing import Optional, Literal
from pydantic import BaseModel, Field


NextAction = Literal["call_tool", "clarify", "answer_directly", "unknown"]


class ClassifyRequest(BaseModel):
    text:       str = Field(..., min_length=1, max_length=2000)
    tenant_id:  str = Field(..., description="UUID — for trace correlation only")
    request_id: Optional[str] = Field(None, description="bot's turnId — for trace correlation")


class ClassifyResponse(BaseModel):
    intent:             str
    next_action:        NextAction
    tool:               Optional[str]
    confidence:         float                          # 0..1
    scores:             dict[str, float]               # top 5 per-class
    normalized:         str                            # lowercased + stripped
    classifier_version: str


class HealthResponse(BaseModel):
    ok:                bool
    model_version:     Optional[str]
    intents_count:     int
    loaded_at:         Optional[str]                   # ISO 8601 timestamp
