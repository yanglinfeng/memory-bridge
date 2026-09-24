#!/usr/bin/env bash
#
# 忆桥接入示例 · curl
#
# 覆盖：健康检查 → 写入文档切片 → 幂等重放 → 召回 → 发布修订版 → 时序对照查询
#
# 用法：
#   export MB_TOKEN=你的令牌          # 见 examples/README.md §1
#   bash examples/curl/quickstart.sh
#
# 可选：
#   MB_BASE=http://127.0.0.1:3789     # 默认打到本机 3789
#
# 依赖：bash 4+、curl、jq

set -uo pipefail

MB_BASE="${MB_BASE:-http://127.0.0.1:3789}"
MB_TOKEN="${MB_TOKEN:-}"
KEY="kb:example-handbook:ch3-s2-$(date +%s)"

if ! command -v jq >/dev/null 2>&1; then
  echo "需要 jq：brew install jq" >&2
  exit 1
fi

# HTTP 状态码经临时文件中转——命令替换 $(...) 是子 shell，变量赋值传不回调用处。
CODE_FILE="$(mktemp)"
trap 'rm -f "$CODE_FILE"' EXIT
code() { cat "$CODE_FILE"; }

# 发请求：正文写 stdout，状态码写入 $CODE_FILE
req() {
  local method="$1" path="$2" data="${3:-}"
  local args=(-sS -X "$method" "$MB_BASE$path" -H 'Content-Type: application/json' -w $'\n%{http_code}')
  [ -n "$MB_TOKEN" ] && args+=(-H "Authorization: Bearer $MB_TOKEN")
  [ -n "$data" ] && args+=(-d "$data")
  local out; out="$(curl "${args[@]}")"
  printf '%s' "$out" | tail -n1 > "$CODE_FILE"
  printf '%s' "$out" | sed '$d'
}

hr() { printf '\n──── %s ────\n' "$1"; }

echo "目标：$MB_BASE"
[ -z "$MB_TOKEN" ] && echo "（未设置 MB_TOKEN：仅健康检查会成功，其余会得到 401）"

# ─────────────────────────────────────────────────────────────── 1. 健康检查
hr "1. 健康检查"
HEALTH="$(req GET /api/health)"
echo "HTTP $(code)  $HEALTH"

# ───────────────────────────────────────────────────── 2. 写入文档切片（v1）
hr "2. 写入文档切片（带 corpusDomain / classification）"
BODY_V1="$(cat <<JSON
{
  "kind": "document_chunk",
  "content": "员工考勤规定：每周须到岗 4 天，其余 1 天可远程办公。迟到超过 30 分钟计为半天事假。",
  "title": "员工手册 > 第三章 考勤 > 3.2 到岗要求",
  "tags": ["kb:document-chunk", "kb:file", "doc:employee-handbook"],
  "source": "kb:file",
  "sourceRef": "employee-handbook.md#ch3-s2",
  "idempotencyKey": "$KEY",
  "importance": 0.5,
  "occurredAt": "2026-09-01T00:00:00Z",
  "corpusDomain": "policy",
  "classification": "internal"
}
JSON
)"
RESP_V1="$(req POST /api/memories "$BODY_V1")"
echo "HTTP $(code)"
FIRST_ID="$(printf '%s' "$RESP_V1" | jq -r '.memory.id // empty')"
echo "memory.id      = $FIRST_ID"
echo "origin         = $(printf '%s' "$RESP_V1" | jq -r '.memory.origin')   （服务端强制打标，客户端无法伪造）"
echo "corpusDomain   = $(printf '%s' "$RESP_V1" | jq -r '.memory.corpusDomain')"
echo "classification = $(printf '%s' "$RESP_V1" | jq -r '.memory.classification')"

if [ -z "$FIRST_ID" ]; then
  echo
  echo "写入未拿到 memory.id，后续步骤无法继续。原始响应：" >&2
  printf '%s\n' "$RESP_V1" >&2
  exit 1
fi

# ────────────────────────────────────────────────────── 3. 幂等：同键重放一次
hr "3. 幂等重放（同一 idempotencyKey）"
RESP_AGAIN="$(req POST /api/memories "$BODY_V1")"
echo "HTTP $(code)"
echo "created        = $(printf '%s' "$RESP_AGAIN" | jq -r '.created')"
echo "deduplicated   = $(printf '%s' "$RESP_AGAIN" | jq -r '.deduplicated')   （true = 命中已有条目，未产生重复）"
SAME="否"; [ "$(printf '%s' "$RESP_AGAIN" | jq -r '.memory.id')" = "$FIRST_ID" ] && SAME="是"
echo "id 是否相同    = $SAME"

# ────────────────────────────────────────────────────────────────────── 4. 召回
hr "4. 召回（查询措辞带上正文关键词，避免 policy 门槛拒答）"
RESP_R="$(req POST /api/recall '{"query":"员工考勤规定 每周须到岗 天 远程办公","limit":3,"contextTokenBudget":800}')"
echo "HTTP $(code)   qualityState = $(printf '%s' "$RESP_R" | jq -r '.qualityState')"
echo "traceId = $(printf '%s' "$RESP_R" | jq -r '.traceId')"
printf '%s' "$RESP_R" | jq -r '.memories[]? | "  score=\(.score * 1000 | round / 1000)  \(.memory.content[0:40])"'
echo
echo "context（可直接拼进 LLM prompt）："
printf '%s' "$RESP_R" | jq -r '.context' | sed 's/^/  | /'

# ──────────────────────────────────────── 5. 发布修订版（supersede 取代旧版）
hr "5. 发布修订版（supersedesId 显式声明取代）"
BODY_V2="$(cat <<JSON
{
  "kind": "document_chunk",
  "content": "员工考勤规定（修订版）：每周须到岗 3 天，其余 2 天可远程办公。",
  "title": "员工手册 > 第三章 考勤 > 3.2 到岗要求（2026-09 修订）",
  "tags": ["kb:document-chunk", "kb:file", "doc:employee-handbook"],
  "source": "kb:file",
  "sourceRef": "employee-handbook.md#ch3-s2-v2",
  "idempotencyKey": "${KEY}-v2",
  "validFrom": "2026-09-20T00:00:00Z",
  "supersedesId": "$FIRST_ID",
  "corpusDomain": "policy",
  "classification": "internal"
}
JSON
)"
RESP_V2="$(req POST /api/memories "$BODY_V2")"
echo "HTTP $(code)    新片段 id = $(printf '%s' "$RESP_V2" | jq -r '.memory.id')"
echo "                validFrom = $(printf '%s' "$RESP_V2" | jq -r '.memory.validFrom')"
OLD_STATUS="$(req GET "/api/memories/$FIRST_ID" | jq -r '.memory.status // .status // "?"')"
echo "旧片段 status = $OLD_STATUS   （应为 superseded）"

# ──────────────────────────────────────────────────── 6. 时序对照：现在 vs 过去
Q='{"query":"员工考勤规定 每周须到岗 天 远程办公","limit":3}'
hr "6a. 查「现在」——应只出现修订版（3 天）"
req POST /api/recall "$Q" | jq -r '.memories[]? | "  \(.memory.content[0:42])｜status=\(.memory.status)"'

hr "6b. 查「过去时点 2026-09-10」——应只出现当时的旧版（4 天）"
req POST /api/recall '{"query":"员工考勤规定 每周须到岗 天 远程办公","limit":3,"timestamp":"2026-09-10T00:00:00Z"}' \
  | jq -r '.memories[]? | "  \(.memory.content[0:42])｜status=\(.memory.status)"'

printf '\n完成。这些数据写在你的数据目录里（示例用固定前缀 kb:example-handbook: 便于识别与清理）。\n'
