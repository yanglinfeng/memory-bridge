#!/usr/bin/env python3
"""忆桥 cross-encoder 重排 sidecar。

POST /rerank  {"query": str, "passages": [str, ...]} -> {"scores": [float, ...], ...}
GET  /health  -> {"status": "ok", "model": ..., "device": ..., "warm": bool}

模型：BAAI/bge-reranker-v2-m3（或经 CE_MODEL_DIR 指定本地权重目录）。
分数为原始 logit：>0 表示相关（sigmoid>0.5），越大越相关。

环境变量：
  CE_MODEL_DIR   模型权重目录（默认 ./models/bge-reranker-v2-m3；不存在则回落 HF id）
  CE_DEVICE      mps | cpu | auto（默认 auto）
  CE_MAX_LEN     单对最大 token（默认 512，可到 8192）
  CE_BATCH       打分批量（默认 32）
  CE_FP16        1=半精度（默认 1；CPU 上自动忽略）
  CE_HOST / CE_PORT  监听地址（默认 127.0.0.1:3798）

启动：./start.sh  或  python3 -m uvicorn server:app --host 127.0.0.1 --port 3798
"""
from __future__ import annotations

import os
import time
from typing import List

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_ID = "BAAI/bge-reranker-v2-m3"
MODEL_DIR = os.environ.get("CE_MODEL_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "models", "bge-reranker-v2-m3"
)
MAX_LEN = int(os.environ.get("CE_MAX_LEN", "512"))
BATCH = max(1, int(os.environ.get("CE_BATCH", "32")))
FP16 = os.environ.get("CE_FP16", "1") == "1"
MAX_PASSAGES = 256

app = FastAPI(title="memory-bridge ce-rerank", docs_url=None, redoc_url=None)
_state = {"model": None, "tokenizer": None, "device": None, "warm": False}


def _pick_device() -> str:
    configured = os.environ.get("CE_DEVICE", "auto")
    if configured != "auto":
        return configured
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def load_model() -> None:
    device = _pick_device()
    source = MODEL_DIR if os.path.isdir(MODEL_DIR) else MODEL_ID
    dtype = torch.float16 if (FP16 and device == "mps") else torch.float32
    tokenizer = AutoTokenizer.from_pretrained(source)
    model = AutoModelForSequenceClassification.from_pretrained(
        source, dtype=dtype
    )
    model.to(device).eval()
    _state.update(model=model, tokenizer=tokenizer, device=device)
    # 预热：触发 MPS 内核编译，避免首个请求吃冷启动延迟
    dummy = tokenizer(["预热"], ["预热"], padding=True, truncation=True,
                      max_length=MAX_LEN, return_tensors="pt").to(device)
    with torch.no_grad():
        model(**dummy)
    _state["warm"] = True


class RerankRequest(BaseModel):
    query: str = Field(min_length=1)
    passages: List[str] = Field(default_factory=list)


class RerankResponse(BaseModel):
    scores: List[float]
    model: str
    device: str
    elapsed_ms: float
    max_len: int


@app.on_event("startup")
def _startup() -> None:
    load_model()


@app.get("/health")
def health() -> dict:
    if _state["model"] is None:
        return {"status": "loading", "warm": False}
    return {
        "status": "ok",
        "model": MODEL_ID,
        "device": _state["device"],
        "warm": _state["warm"],
        "max_len": MAX_LEN,
        "batch": BATCH,
    }


@app.post("/rerank")
def rerank(req: RerankRequest) -> RerankResponse:
    model = _state["model"]
    tokenizer = _state["tokenizer"]
    device = _state["device"]
    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="模型尚未加载完成")
    if len(req.passages) > MAX_PASSAGES:
        raise HTTPException(
            status_code=422,
            detail=f"单次最多 {MAX_PASSAGES} 条候选",
        )
    started = time.perf_counter()
    scores: List[float] = []
    with torch.no_grad():
        for i in range(0, len(req.passages), BATCH):
            chunk = req.passages[i : i + BATCH]
            inputs = tokenizer(
                [req.query] * len(chunk),
                [p if p.strip() else "（空）" for p in chunk],
                padding=True,
                truncation=True,
                max_length=MAX_LEN,
                return_tensors="pt",
            ).to(device)
            logits = model(**inputs).logits.view(-1).float()
            scores.extend(logits.cpu().tolist())
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    return RerankResponse(
        scores=scores,
        model=MODEL_ID,
        device=device or "cpu",
        elapsed_ms=elapsed_ms,
        max_len=MAX_LEN,
    )
