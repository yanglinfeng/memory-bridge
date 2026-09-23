module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        message: [
          "node bundle/scripts/generate-mcp-config.mjs --app-root app --state-dir state --output state/receipts/mcp-config.json"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "MCP stdio 配置已生成到 state/receipts/mcp-config.json，可复制到 AIRI 或其他 MCP 客户端。"
      }
    }
  ]
}
