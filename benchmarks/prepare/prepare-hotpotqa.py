#!/usr/bin/env python3
"""构建 HotpotQA（distractor 模式）英文知识库评测语料。

与 CMRC 同一套理由不随仓库分发原始数据：HotpotQA 的许可是 **CC BY-SA 4.0**，
与仓库的 Apache-2.0 不同；且原始 parquet 27 MB / 转出的 JSONL 46 MB，不该进 git。

依赖：`duckdb`
    python3 -m venv .venv && .venv/bin/pip install duckdb
    .venv/bin/python benchmarks/prepare/prepare-hotpotqa.py

产物（默认写入 benchmarks/.work/corpus/）：
    hotpot-distractor.jsonl      7405 题，每题自带 10 段落（2 gold + 8 干扰）；44 MB
    hotpot-manifest.json         题数 / bridge-comparison 分布 / sha256

原始 parquet 26 MB，转出的 JSONL 44 MB——这也是它不进 git 的实际原因。

每题字段：id, question, answer, type(bridge|comparison), level,
          gold_titles, gold_sent_ids, para_titles, para_sentences

为什么保留 `para_sentences` 的**原始切句**而不合并成整段：
  `gold_sent_ids` 指向句级位置，评测侧要靠它算「证据句召回」；一旦合并成整段，
  这个维度就永久丢失。写入时再把句子拼成段落文本即可（见 run-hotpotqa.mjs）。

抽样口径：本文件产出**全量 7405 题**；评测脚本（`run-hotpotqa.mjs`）按
  bridge:comparison = 8:2 做等距确定性抽样，题数由运行时的 `MEMORY_BRIDGE_BENCH_N`
  控制（本脚本无题数参数），保证任一 N 的题集稳定、可复现。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

# HotpotQA 官方与 HF 原路径常 404，走 hf-mirror
DEFAULT_BASE = "https://hf-mirror.com/datasets/hotpotqa/hotpot_qa/resolve/main"
PARQUET = "distractor/validation-00000-of-00001.parquet"


def fetch(url: str, target: Path) -> Path:
    if target.exists() and target.stat().st_size > 0:
        print(f"  已存在，跳过下载：{target.name}")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  下载 {url}")
    with urllib.request.urlopen(url, timeout=600) as response, target.open("wb") as out:
        out.write(response.read())
    print(f"  完成 {target.name}（{target.stat().st_size / 1024 / 1024:.1f} MB）")
    return target


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 HotpotQA distractor 评测语料")
    parser.add_argument("--out", type=Path, default=None, help="输出目录")
    parser.add_argument("--data", type=Path, default=None, help="parquet 缓存目录")
    parser.add_argument("--base-url", default=DEFAULT_BASE, help="数据集下载前缀")
    args = parser.parse_args()

    try:
        import duckdb  # noqa: PLC0415
    except ImportError:
        print("缺少 duckdb：pip install duckdb", file=sys.stderr)
        return 2

    repo = Path(__file__).resolve().parents[2]
    out_dir = args.out or (repo / "benchmarks" / ".work" / "corpus")
    data_dir = args.data or (repo / "benchmarks" / ".work" / "raw")
    out_dir.mkdir(parents=True, exist_ok=True)

    print("=== 1/3 取数据 ===")
    parquet = fetch(f"{args.base_url}/{PARQUET}", data_dir / "hotpot-validation-distractor.parquet")

    print("=== 2/3 转换 ===")
    con = duckdb.connect()
    try:
        rows = con.execute(
            f"""SELECT id, question, answer, type, level,
                       supporting_facts, context
                FROM read_parquet('{parquet}')"""
        ).fetchall()
    finally:
        con.close()
    print(f"  读取 {len(rows)} 题")

    out_path = out_dir / "hotpot-distractor.jsonl"
    counts = {"bridge": 0, "comparison": 0}
    with out_path.open("w", encoding="utf-8") as handle:
        for row in rows:
            question_id, question, answer, qtype, level, supporting, context = row
            # supporting_facts: {'title': [...], 'sent_id': [...]}
            gold_titles = list(supporting["title"]) if isinstance(supporting, dict) else list(supporting[0])
            gold_sent_ids = list(supporting["sent_id"]) if isinstance(supporting, dict) else list(supporting[1])
            # context: {'title': [...], 'sentences': [[...], ...]}
            para_titles = list(context["title"]) if isinstance(context, dict) else list(context[0])
            para_sentences = [list(s) for s in (context["sentences"] if isinstance(context, dict) else context[1])]
            counts[qtype] = counts.get(qtype, 0) + 1
            handle.write(json.dumps({
                "id": question_id,
                "question": question,
                "answer": answer,
                "type": qtype,
                "level": level,
                "gold_titles": gold_titles,
                "gold_sent_ids": gold_sent_ids,
                "para_titles": para_titles,
                "para_sentences": para_sentences,
            }, ensure_ascii=False) + "\n")

    print("=== 3/3 写出 ===")
    manifest = {
        "dataset": "hotpotqa/hotpot_qa",
        "config": "distractor",
        "split": "validation",
        "dataset_license": "CC BY-SA 4.0",
        "questions": len(rows),
        "by_type": counts,
        "sampling": "评测脚本按 bridge:comparison = 8:2 等距确定性抽样",
        "data_sha256": sha256_of(out_path),
    }
    (out_dir / "hotpot-manifest.json").write_text(
        f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"\n产物：{out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
