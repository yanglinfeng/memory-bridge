# syntax=docker/dockerfile:1
#
# 忆桥（Memory Bridge）容器镜像
# ============================================================================
# 默认入口是 MCP stdio 传输，供 Claude Desktop / Cline / Glama 等 MCP 客户端
# 直接接入：
#
#   docker build -t mcp-memory-bridge .
#   docker run -i --rm -v mb-data:/data mcp-memory-bridge
#
# HTTP 模式（管理台 + HTTP API，默认端口 3789）：
#
#   忆桥只监听回环地址（127.0.0.1 / ::1），这是有意的安全契约——服务信任
#   loopback 上的无令牌请求。因此容器里**不能**用 `-p 3789:3789` 做端口映射：
#   映射到的是容器自己的回环，宿主机连不上。请改用宿主机网络：
#
#     Linux：
#       docker run --rm --network host -v mb-data:/data \
#         -e MEMORY_BRIDGE_OLLAMA_URL=http://127.0.0.1:11434 \
#         mcp-memory-bridge dist/server/index.js
#
#     Docker Desktop（macOS / Windows）：
#       先在 Settings → Resources 里启用 "Enable host networking"，
#       参数与上面相同。
#
# 推理运行时（Ollama）不包含在本镜像内：
#   - Docker Desktop：默认的 host.docker.internal 可直接用；
#   - Linux：需加 --add-host=host.docker.internal:host-gateway
#     （或直接用上面的 --network host，此时用 127.0.0.1 即可）。
#
# 数据持久化：SQLite 库与派生索引都在 /data（挂载卷，否则容器删除即丢）。
# ============================================================================

# ── 构建阶段 ────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

WORKDIR /build

# 先装依赖，利用层缓存：源码改动不会让这次安装重跑。
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY src ./src

RUN npm run build

# ── 运行阶段 ────────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="忆桥 (Memory Bridge)" \
      org.opencontainers.image.description="Local-first, evidence-backed knowledge and memory MCP server with audit, versioning and namespace isolation." \
      org.opencontainers.image.source="https://github.com/yanglinfeng/memory-bridge" \
      org.opencontainers.image.licenses="Apache-2.0"

# MEMORY_BRIDGE_USER_ID 必须给出：MCP 启动时若既无 USER_ID 也无 MCP_TOKEN
# 会直接拒绝启动。
ENV NODE_ENV=production \
    MEMORY_BRIDGE_DATA_DIR=/data \
    MEMORY_BRIDGE_USER_ID=default \
    MEMORY_BRIDGE_NAMESPACE=personal \
    MEMORY_BRIDGE_OLLAMA_URL=http://host.docker.internal:11434

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /build/dist ./dist
COPY docs ./docs

RUN mkdir -p /data
VOLUME ["/data"]

# ENTRYPOINT 只固定解释器：默认跑 stdio MCP；需要 HTTP 模式时把 CMD 换成
# dist/server/index.js 即可（见文件头部示例）。
ENTRYPOINT ["node"]
CMD ["dist/server/mcp-stdio.js"]
