#!/usr/bin/env python3
"""构建 CMRC 2018 中文评测语料（不随仓库分发原始数据，只按规则生成）。

为什么用脚本而不是把语料提交进仓库：
  1. CMRC 2018 的许可是 **CC BY-SA 4.0**（署名 + 相同方式共享），而本仓库是
     Apache-2.0。把第三方语料提交进来会引入一段混合许可，还要额外维护署名与再分发
     条款。改为从官方镜像现取，仓库只保留**规则**，许可边界最干净。
  2. 体量：500 题档的语料约 3.7 MB，留在仓库里对 clone 是纯负担。

依赖：`duckdb`（读 parquet）。
    python3 -m venv .venv && .venv/bin/pip install duckdb
    .venv/bin/python benchmarks/prepare/prepare-cmrc.py --n 100

产物（默认写入 benchmarks/.work/corpus/）：
    cmrc-corpus-<n>.json      [{id, text}]        金文档 + train 干扰文档
    cmrc-questions-<n>.json   [{id, context, question, gold}]
    cmrc-manifest-<n>.json    题数/文档数/各文件 sha256（用于对齐报告里的数字）

──────────────────────────── 构造规则（已实测核对） ────────────────────────────

**可字节级复现的部分**（用 seed=20260916 与下述算法，已与已记录基线逐字比对一致）：

  1. 读 validation parquet，**保持 parquet 原始行序**，`random.Random(seed).shuffle()`
     后取前 N 题。
  2. 题按抽样顺序排列（不是按 id 排序）——这决定 `cmrc-questions-*.json` 的顺序。
  3. 金文档 = 抽样题的 `context` 按**首次出现顺序**去重，id = `cmrc-val-<i>`。
  4. `questions[i].context` 是**逐字原文**，评测脚本靠它反查金文档 id ——
     任何改写都会断链，导致金文档匹配失败、召回指标全塌。

  已验证：100 题与 500 题两档的「题目文件」与「金文档部分」与已记录基线**完全一致**，
  且前 100 题是 500 题的前缀（前缀稳定，两档可直接对照）。

**不可复现的部分（如实标注）**：干扰文档的**抽取顺序**。生成已记录基线的那段脚本
  当时没有留档，用穷举尝试（多种排序基准 × shuffle/sample × 多个种子）都无法复原其
  次序。本脚本改为：train 去重 → 剔除与任一份金文档相同的文本（防金文档污染）→
  用同一 seed 做确定性 shuffle → 取到目标规模。

  影响面：干扰集的**来源与规模一致**（train 唯一段落，金文档零污染），但具体抽取到
  哪些干扰、以及它们的排列次序与基线不同。由于干扰文档的 `occurredAt` 按数组下标生成，
  次序差异也会带来轻微的时间分布差异。

  ⇒ 因此复现出的数字应视为**同条件可复现**，而非与报告逐题一致；
    引用已记录基线时必须连带引用其语料 fingerprint（见 manifest 与 BENCHMARKS.md）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import urllib.request
from pathlib import Path

# hf-mirror 是境内可用的 HF 镜像；官方 huggingface.co 在本机常连不上。
DEFAULT_BASE = "https://hf-mirror.com/datasets/hfl/cmrc2018/resolve/main/data"
FILES = {
    "validation": "validation-00000-of-00001.parquet",
    "train": "train-00000-of-00001.parquet",
}
# 已记录基线使用的种子。换成别的值会得到不同的题集，数字不再可比。
DEFAULT_SEED = 20260916
# 已记录基线的规模档：100 题→1000 篇、500 题→2000 篇。
DOCS_BY_N = {100: 1000, 500: 2000}


def fetch(url: str, target: Path) -> Path:
    if target.exists() and target.stat().st_size > 0:
        print(f"  已存在，跳过下载：{target.name}")
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    print(f"  下载 {url}")
    with urllib.request.urlopen(url, timeout=300) as response, target.open("wb") as out:
        out.write(response.read())
    print(f"  完成 {target.name}（{target.stat().st_size / 1024 / 1024:.1f} MB）")
    return target


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_rows(duckdb_module, parquet: Path, columns: str) -> list[tuple]:
    con = duckdb_module.connect()
    try:
        # 不排序、不 parallel：保持 parquet 物理行序，抽样才可复现
        return con.execute(
            f"SELECT {columns} FROM read_parquet('{parquet}')"
        ).fetchall()
    finally:
        con.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="构建 CMRC 2018 评测语料")
    parser.add_argument("--n", type=int, default=100, help="抽样题数（已记录基线：100 / 500）")
    parser.add_argument("--docs", type=int, default=0,
                        help="目标文档总数，0 = 按已记录基线推断（100→1000、500→2000）")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="抽样种子")
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
    target_docs = args.docs or DOCS_BY_N.get(args.n, args.n * 10)

    print("=== 1/4 取数据 ===")
    validation = fetch(f"{args.base_url}/{FILES['validation']}", data_dir / FILES["validation"])
    train = fetch(f"{args.base_url}/{FILES['train']}", data_dir / FILES["train"])

    print("=== 2/4 抽样题目（保持 parquet 原序 → shuffle → 取前 N） ===")
    rows = load_rows(duckdb, validation, "id, context, question, answers")
    shuffled = list(rows)
    random.Random(args.seed).shuffle(shuffled)
    picked = shuffled[: args.n]
    print(f"  validation 共 {len(rows)} 题，抽 {len(picked)} 题（seed={args.seed}）")

    questions = []
    gold_texts: list[str] = []
    gold_index: dict[str, int] = {}
    for question_id, context, question, answers in picked:
        # duckdb 把 STRUCT 解成 dict：{'text': [...], 'answer_start': [...]}
        texts = answers["text"] if isinstance(answers, dict) else answers[0]
        gold = texts[0] if texts else ""
        if context not in gold_index:
            gold_index[context] = len(gold_texts)
            gold_texts.append(context)
        questions.append({
            "id": question_id,
            "context": context,
            "question": question,
            "gold": gold,
        })

    print("=== 3/4 组装文档库 ===")
    corpus = [{"id": f"cmrc-val-{index}", "text": text}
              for index, text in enumerate(gold_texts)]
    print(f"  金文档 {len(corpus)} 篇（{len(picked)} 题去重后）")

    gold_set = set(gold_index)
    train_rows = load_rows(duckdb, train, "context")
    seen: set[str] = set()
    distractors: list[str] = []
    skipped_gold = 0
    for (text,) in train_rows:
        if text in gold_set:
            skipped_gold += 1
            continue
        if text in seen:
            continue
        seen.add(text)
        distractors.append(text)
    print(f"  训练集唯一段落 {len(distractors)} 篇"
          f"（跳过 {skipped_gold} 条与金文档重复的行、{len(train_rows) - skipped_gold - len(distractors)} 条重复行）")
    random.Random(args.seed).shuffle(distractors)
    distractors = distractors[: max(0, target_docs - len(corpus))]
    corpus.extend({"id": f"cmrc-train-distract-{index}", "text": text}
                  for index, text in enumerate(distractors))
    print(f"  取 {len(distractors)} 篇作干扰｜文档合计 {len(corpus)}")
    if len(corpus) < target_docs:
        print(f"  ⚠️ 干扰不足：目标 {target_docs} 篇，实得 {len(corpus)} 篇")

    print("=== 4/4 写出 ===")
    suffix = str(args.n) if args.docs == 0 else f"{args.n}-docs{target_docs}"
    corpus_path = out_dir / f"cmrc-corpus-{suffix}.json"
    questions_path = out_dir / f"cmrc-questions-{suffix}.json"
    corpus_path.write_text(json.dumps(corpus, ensure_ascii=False), encoding="utf-8")
    questions_path.write_text(json.dumps(questions, ensure_ascii=False), encoding="utf-8")

    manifest = {
        "dataset": "hfl/cmrc2018",
        "dataset_license": "CC BY-SA 4.0",
        "seed": args.seed,
        "questions": len(questions),
        "documents": len(corpus),
        "gold_documents": len(gold_texts),
        "distractor_documents": len(distractors),
        "reproducible": {
            "questions": "与已记录基线逐字一致（已验证）",
            "gold_documents": "与已记录基线逐字一致（已验证）",
            "distractors": "同源同规模，但抽取次序与基线不同（原生成脚本未留档）",
        },
        "corpus_sha256": sha256_of(corpus_path),
        "questions_sha256": sha256_of(questions_path),
    }
    (out_dir / f"cmrc-manifest-{suffix}.json").write_text(
        f"{json.dumps(manifest, ensure_ascii=False, indent=2)}\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"\n产物：{out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
