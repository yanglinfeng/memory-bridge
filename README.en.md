# Memory Bridge

**Local-first, evidence-backed knowledge & memory layer for MCP.**

[English](README.en.md) · [简体中文](README.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A524-green)
![Schema](https://img.shields.io/badge/schema-v44-blue)
![MCP](https://img.shields.io/badge/protocol-MCP-purple)

The biggest risk in an AI knowledge base is not "it can't answer" — it's **fabrication**
and **citing a document that has already been superseded**. Memory Bridge attaches
sources to every sentence, keeps an audit trail for every change, and isolates data
per department. Nothing leaves your machine.

## Why Memory Bridge

| Problem every enterprise RAG hits | What Memory Bridge does |
|---|---|
| Which file, which paragraph did this sentence come from? | Non-destructive consolidation binds every sentence to its source; every recall carries a `traceId` and replays *query rewrite → candidates → fusion → rerank → selection → injection* |
| The document was revised — is the old answer still being cited? | Document-level version chain: content changes go through `supersede`, superseded versions drop out of default retrieval, and the history stays auditable |
| Who can see it, who changed it? | User / namespace / scope isolation, trusted-session issuance with a grants matrix, and a full operation audit log |

## What's implemented

**Retrieval & answering**

- Whole-corpus hybrid retrieval — FTS5 + dense ANN + concept inverted index + strict rerank, with no "last N items" pre-truncation
- Cross-encoder reranking via a `bge-reranker-v2-m3` Python sidecar, with per-corpus-domain relevance gates (`policy` / `open`)
- Relevance filler keeps multi-hop evidence chains intact when strict rerank returns too few items
- Abstention profile: if the corpus does not contain the answer, it says so instead of improvising
- Answer tools — `calculator`, `date_diff`, `date_shift`: arithmetic and date math are computed, not guessed
- Bi-temporal recall: the retrieval window is bounded by `valid_from` / `valid_to`

**Integration surface**

- **7 MCP tools**: `memory_remember` · `memory_recall` · `memory_get_context` · `memory_update` · `memory_forget` · `memory_list` · `memory_stats`
- HTTP API, an OpenAI-compatible endpoint, and a React console (candidate review, version evidence, recall explanations, index watermark, system health)
- A direct write channel for knowledge-base / RAG ingestion layers, with a field-level contract in [docs/api-接口文档.md](docs/api-接口文档.md)

**Memory governance**

- Fast path for natural-language remember / correct / forget; corrections keep a stable UUID and append versions; forgetting writes a tombstone first
- Cross-session inference always lands in a pending-review queue — confirm, reject, or block future equivalent claims. There is no "auto-commit inference" switch
- Non-destructive consolidation: summaries invalidate and rebuild when their sources change or are forgotten
- Your data is kept by default: no automatic decay, no evidence scrubbing

**Engineering**

- SQLite (`node:sqlite`) with an outbox / jobs layer: leases, retries, dead letters, crash replay, idempotent execution
- Full operation audit + retrieval JSONL logs (metadata / diagnostic levels, redaction, rotation, retention)
- Read-only Memory Doctor: duplicates, conflicts, orphans, stale summaries, oversized memories, zero-result hotspots
- Every model is configurable: default generation `qwen2.5:14b`, embedding `bge-m3:latest` via Ollama. No cloud service required

## Quick Start

Prerequisites: Node.js ≥ 24 and a running Ollama.

```bash
ollama pull qwen2.5:14b
ollama pull bge-m3:latest

git clone https://github.com/yanglinfeng/memory-bridge.git
cd memory-bridge
npm install
npm run build
npm start          # HTTP server + console at http://127.0.0.1:3789
```

The first launch starts with an empty memory store — no demo data. The console only
shows what you actually wrote.

Wire it into any MCP client (Claude Desktop, Cline, …):

```json
{
  "mcpServers": {
    "memory-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/memory-bridge/dist/server/mcp-stdio.js"]
    }
  }
}
```

### Examples

Three **zero-build, directly runnable** examples (curl / Node / Java) cover writes (including
`corpusDomain` / `classification`), idempotent replay, recall, `supersede` revisions and
point-in-time (as-of) queries:

```bash
export MB_TOKEN=your-token        # see examples/README.md §1

bash examples/curl/quickstart.sh
node examples/node/quickstart.mjs
java examples/java/QuickStart.java      # JDK 17+, no dependencies
```

See [examples/README.md](examples/README.md) (Chinese).

### Docs consistency

Facts declared in the docs — schema version, environment variables, npm scripts, HTTP routes,
config defaults — can be diffed against the code in one command:

```bash
npm run check:docs
```

It fails with a non-zero exit code on any mismatch, so it is worth re-running before a release
and after any large change. See [CONTRIBUTING.md](CONTRIBUTING.md).

Full installation, operations, API and troubleshooting docs start at
[docs/README.md](docs/README.md) (Chinese; English guides are on the roadmap).

## Evaluation

Memory Bridge ships its own evaluation and load-testing harness (40+ runnable scripts
under `scripts/`, covering retrieval, reranking, consolidation, namespace isolation,
context reflection, scale, reliability and crash recovery), plus date- and
environment-stamped evidence snapshots in [`docs/acceptance-report-*.md`](docs/).

**The full conditions and one-command reproduction scripts for the public benchmarks
(English knowledge-base QA, a Chinese in-house set, and large-scale latency) will ship
in `BENCHMARKS.md`. Until those numbers are reproducible, this README claims no
scores** — that is part of what "trust layer" means here.

## How it differs (by dimension, not by size)

| Dimension | Memory Bridge | mem0 | Zep / Graphiti | RAGFlow | AnythingLLM |
|---|---|---|---|---|---|
| Verifiable citations (source binding + `traceId`) | ✅ | — | — | ✅ | Partial |
| Temporal validity (superseded versions leave retrieval) | ✅ document-level | — | ✅ fact-level | — | — |
| Full operation audit log | ✅ | Enterprise | ✅ | — | — |
| Namespace / department isolation | ✅ trusted sessions + grants matrix | Enterprise | ✅ | Team-level | Workspace |
| Forgetting & correction (tombstone / version append) | ✅ | ✅ | ✅ | — | — |
| Fully offline, data never leaves the machine | ✅ | Partial | ❌ self-hosted community edition discontinued | ✅ | ✅ |
| MCP native | ✅ 7 tools | ✅ | Community wrapper | ✅ | — |

> This table only records whether a mechanism **exists architecturally**; it does not
> rank quality. Every project moves fast — check each repository for the current state.

## Roadmap

- [ ] `BENCHMARKS.md`: full conditions and one-command reproduction for the public benchmarks
- [ ] `CHANGELOG.md` / `CONTRIBUTING.md` / `SECURITY.md`
- [ ] Write `valid_to` on `supersede`, plus as-of query regression tests
- [x] English documentation entry point (`README.en.md`)
- [ ] English versions of the core guides
- [ ] Deeper document parsing: pair with upstream RAGFlow / Docling, and keep Memory Bridge focused on the trust layer above them

## License

[Apache-2.0](./LICENSE)
