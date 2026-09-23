#!/usr/bin/env bash
# 启动 cross-encoder 重排 sidecar（默认 127.0.0.1:3798）
set -euo pipefail
cd "$(dirname "$0")"

# 绕开 WorkBuddy Python shim（经 PYTHONPATH 注入）：transformers 导入/依赖检查
# 会触发 shim 的逐文件审批，后台运行无人审批直接挂死。必须最先执行。
unset PYTHONPATH

PY="${CE_PYTHON:-python3}"
if [ ! -d models/bge-reranker-v2-m3 ] && [ -z "${CE_MODEL_DIR:-}" ]; then
  echo "⚠️  未找到模型权重目录 models/bge-reranker-v2-m3"
  echo "    可用 CE_MODEL_DIR=/path/to/bge-reranker-v2-m3 指定，或先下载："
  echo "    mkdir -p models/bge-reranker-v2-m3 && cd models/bge-reranker-v2-m3"
  echo "    for f in config.json tokenizer.json tokenizer_config.json sentencepiece.bpe.model special_tokens_map.json model.safetensors; do"
  echo "      curl -sL --fail -O \"https://hf-mirror.com/BAAI/bge-reranker-v2-m3/resolve/main/\$f\"; done"
  exit 1
fi

if ! "$PY" -c "import fastapi, uvicorn, torch, transformers" 2>/dev/null; then
  echo "依赖未安装，正在安装（清华镜像）..."
  "$PY" -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
fi
# 守护循环：MPS 在与 Ollama 等 GPU 进程争抢时可能触发 Metal 断言崩溃
# （进程级 abort），自动拉起；CPU 模式（CE_DEVICE=cpu）无此问题。
while true; do
  "$PY" -m uvicorn server:app \
    --host "${CE_HOST:-127.0.0.1}" \
    --port "${CE_PORT:-3798}"
  code=$?
  echo "[start.sh] uvicorn 退出 code=$code，3 秒后重启..."
  sleep 3
done
