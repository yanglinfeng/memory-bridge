#!/bin/zsh

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PORT="3789"
BASE_URL="http://127.0.0.1:${PORT}"
HEALTH_URL="${BASE_URL}/api/health"
OLLAMA_URL="http://127.0.0.1:11434/api/tags"
CHAT_MODEL="qwen2.5:14b"
EMBED_MODEL="bge-m3:latest"
LOG_DIR="${PROJECT_DIR}/logs"

export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

pause_on_error() {
  echo
  echo "启动没有完成。按回车键关闭此窗口。"
  read -r
}

memory_bridge_is_ready() {
  /usr/bin/curl --silent --fail --max-time 2 "${HEALTH_URL}" 2>/dev/null |
    /usr/bin/grep --fixed-strings --quiet '"service":"memory-bridge"'
}

ollama_is_ready() {
  /usr/bin/curl --silent --fail --max-time 2 "${OLLAMA_URL}" >/dev/null 2>&1
}

wait_for_ollama() {
  for attempt in {1..30}; do
    if ollama_is_ready; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

ensure_model() {
  local model_name="$1"
  if "${OLLAMA_BIN}" show "${model_name}" >/dev/null 2>&1; then
    return 0
  fi

  echo "首次使用需要下载模型 ${model_name}，请不要关闭窗口。"
  "${OLLAMA_BIN}" pull "${model_name}"
}

cd "${PROJECT_DIR}" || {
  echo "找不到忆桥项目目录：${PROJECT_DIR}"
  pause_on_error
  exit 1
}

/bin/mkdir -p "${LOG_DIR}"

OLLAMA_BIN="$(command -v ollama 2>/dev/null || true)"
if [[ -z "${OLLAMA_BIN}" && -x "/Applications/Ollama.app/Contents/Resources/ollama" ]]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/Resources/ollama"
fi

if [[ -z "${OLLAMA_BIN}" ]]; then
  echo "没有找到 Ollama。请先安装 Ollama，再双击本文件。"
  /usr/bin/open "https://ollama.com/download/mac" >/dev/null 2>&1 || true
  pause_on_error
  exit 1
fi

if ! ollama_is_ready; then
  echo "正在启动 Ollama……"
  if [[ -d "/Applications/Ollama.app" ]]; then
    /usr/bin/open -gj -a Ollama >/dev/null 2>&1 || true
  fi

  if ! wait_for_ollama; then
    /usr/bin/nohup "${OLLAMA_BIN}" serve >>"${LOG_DIR}/ollama-launcher.log" 2>&1 &
    if ! wait_for_ollama; then
      echo "Ollama 未能启动。"
      echo "日志：${LOG_DIR}/ollama-launcher.log"
      pause_on_error
      exit 1
    fi
  fi
fi

ensure_model "${CHAT_MODEL}" || {
  pause_on_error
  exit 1
}
ensure_model "${EMBED_MODEL}" || {
  pause_on_error
  exit 1
}

if memory_bridge_is_ready; then
  echo "忆桥已经在运行，正在打开界面……"
  /usr/bin/open "${BASE_URL}"
  exit 0
fi

if /usr/sbin/lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 ${PORT} 已被其他程序占用，因此没有启动忆桥。"
  pause_on_error
  exit 1
fi

if [[ ! -d "node_modules" ]]; then
  echo "首次启动需要安装项目依赖……"
  npm ci || {
    pause_on_error
    exit 1
  }
fi

if [[ ! -f "dist/server/index.js" || ! -f "dist/web/index.html" ]]; then
  echo "首次启动需要构建忆桥……"
  npm run build || {
    pause_on_error
    exit 1
  }
fi

echo "正在启动忆桥：${BASE_URL}"
echo "模型：${CHAT_MODEL}；向量模型：${EMBED_MODEL}"
echo "这个窗口需要保持打开；关闭窗口即可停止忆桥。"

(
  for attempt in {1..90}; do
    if memory_bridge_is_ready; then
      /usr/bin/open "${BASE_URL}"
      exit 0
    fi
    /bin/sleep 1
  done
) &
WAITER_PID=$!

export MEMORY_BRIDGE_HOST="127.0.0.1"
export MEMORY_BRIDGE_PORT="${PORT}"
export MEMORY_BRIDGE_DATA_DIR="${PROJECT_DIR}/data"
export MEMORY_BRIDGE_SEMANTIC_MODE="required"
export MEMORY_BRIDGE_OLLAMA_URL="http://127.0.0.1:11434"
export MEMORY_BRIDGE_AIRI_CHAT_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_EMBED_MODEL="${EMBED_MODEL}"
export MEMORY_BRIDGE_QUERY_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_RERANK_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_EXTRACTION_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_RELATION_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_CONSOLIDATION_MODEL="${CHAT_MODEL}"
export MEMORY_BRIDGE_REFLECTION_MODEL="${CHAT_MODEL}"

npm start
STATUS=$?

/bin/kill "${WAITER_PID}" >/dev/null 2>&1 || true

if [[ "${STATUS}" -ne 0 ]]; then
  pause_on_error
fi

exit "${STATUS}"
