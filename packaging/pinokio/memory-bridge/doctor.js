const path = require("path")

function runtimePort(kernel) {
  const local = kernel.memory.local[path.resolve(__dirname, "start.js")] || {}
  const direct = Number(local.port)
  if (Number.isInteger(direct) && direct >= 1 && direct <= 65535) return direct
  try {
    const fromUrl = Number(new URL(String(local.url)).port)
    if (Number.isInteger(fromUrl) && fromUrl >= 1 && fromUrl <= 65535) {
      return fromUrl
    }
  } catch {
    // Older launcher state may not have a usable URL or explicit port.
  }
  throw new Error("找不到当前 Memory Bridge 实例端口；请先启动一次服务，再运行故障诊断。")
}

module.exports = async (kernel) => {
  const port = runtimePort(kernel)
  return {
    run: [
      {
        method: "shell.run",
        params: {
          message: [
            `node bundle/scripts/memory-bridge-lifecycle.mjs doctor --source bundle --install-root app --state-dir state --mcp-smoke --host 127.0.0.1 --port ${port} --receipt-dir state/receipts`
          ]
        }
      },
      {
        method: "notify",
        params: {
          html: "故障诊断已完成。完整 JSON 回执和 SHA-256 已保存到 state/receipts。"
        }
      }
    ]
  }
}
