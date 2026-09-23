const path = require("path")

module.exports = async (kernel) => {
  const availablePort = await kernel.port()
  const startScript = path.resolve(__dirname, "start.js")
  const appRoot = path.resolve(__dirname, "app")
  return {
    daemon: true,
    run: [
      {
        method: "shell.run",
        params: {
          group: startScript,
          path: "app",
          env: {
            MEMORY_BRIDGE_HOST: "127.0.0.1",
            MEMORY_BRIDGE_PORT: availablePort,
            MEMORY_BRIDGE_DATA_DIR: path.resolve(__dirname, "state", "data"),
            MEMORY_BRIDGE_SEMANTIC_MODE: "required",
            MEMORY_BRIDGE_OLLAMA_URL: "http://127.0.0.1:11434",
            MEMORY_BRIDGE_AIRI_CHAT_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_EMBED_MODEL: "bge-m3:latest",
            MEMORY_BRIDGE_QUERY_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_RERANK_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_EXTRACTION_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_RELATION_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_EXPLICIT_INTENT_MODEL: "qwen2.5:14b",
            MEMORY_BRIDGE_CONSOLIDATION_MODEL: "qwen2.5:14b"
          },
          message: ["node dist/server/index.js"],
          on: [{
            event: "/(http:\\/\\/[0-9.:]+)/",
            done: true
          }]
        }
      },
      {
        method: "local.set",
        params: {
          url: "{{input.event[1]}}",
          pid: "{{input.pid}}",
          cwd: appRoot,
          group: startScript,
          host: "127.0.0.1",
          port: availablePort
        }
      }
    ]
  }
}
