const fs = require("fs")
const path = require("path")

const receiptFile = path.resolve(__dirname, "state", "receipts", "stop-postflight.latest.json")

function stoppedRuntimeIdentity(kernel) {
  const startScript = path.resolve(__dirname, "start.js")
  const appRoot = path.resolve(__dirname, "app")
  const local = kernel.memory?.local?.[startScript] || {}
  let prior = {}
  if (fs.existsSync(receiptFile)) {
    try {
      prior = JSON.parse(fs.readFileSync(receiptFile, "utf8"))
    } catch {
      throw new Error("Stop postflight receipt 无效，拒绝 Restore。")
    }
  }
  const pid = Number(local.pid || prior.pid)
  const cwd = path.resolve(String(local.cwd || prior.cwd || ""))
  let readyUrl
  try {
    readyUrl = new URL(String(local.url || prior.readyUrl || ""))
  } catch {
    throw new Error("缺少已停止实例的 runtime identity，拒绝 Restore。")
  }
  const port = Number(local.port || readyUrl.port)
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    cwd !== appRoot ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    port === 3789 ||
    readyUrl.protocol !== "http:" ||
    readyUrl.hostname !== "127.0.0.1" ||
    Number(readyUrl.port) !== port ||
    readyUrl.pathname !== "/" ||
    readyUrl.search ||
    readyUrl.hash ||
    readyUrl.username ||
    readyUrl.password
  ) {
    throw new Error("已停止实例 PID/cwd/ready URL 身份不匹配，拒绝 Restore。")
  }
  return { pid, cwd, readyUrl: readyUrl.toString() }
}

module.exports = async (kernel) => {
  const serviceRunning = await kernel.running(__dirname, "start.js")
  if (serviceRunning) {
    throw new Error("忆桥服务仍在运行，Restore 已拒绝；请先使用“安全停止”。")
  }
  const runtime = stoppedRuntimeIdentity(kernel)
  return {
    run: [
      {
        method: "shell.run",
        params: {
          message: [
            [
              "node bundle/scripts/memory-bridge-lifecycle.mjs stop --phase postflight",
              "--source bundle --install-root app --state-dir state",
              `--pid ${runtime.pid}`,
              `--cwd ${JSON.stringify(runtime.cwd)}`,
              `--ready-url ${JSON.stringify(runtime.readyUrl)}`,
              "--verify-stopped --receipt-file state/receipts/stop-postflight.latest.json"
            ].join(" ")
          ]
        }
      },
      {
        method: "filepicker.open",
        params: {
          title: "选择忆桥 SQLite 备份",
          type: "file",
          path: "state/backups",
          filetypes: [["Memory Bridge SQLite backup", "*.sqlite3"]],
          multiple: false
        }
      },
      {
        method: "shell.run",
        params: {
          env: {
            MEMORY_BRIDGE_RESTORE_BACKUP: "{{input.paths[0]}}"
          },
          message: [
            "node bundle/scripts/memory-bridge-lifecycle.mjs restore --source bundle --install-root app --state-dir state --backup-env MEMORY_BRIDGE_RESTORE_BACKUP --stop-receipt state/receipts/stop-postflight.latest.json"
          ]
        }
      },
      {
        method: "notify",
        params: {
          html: "忆桥数据库已安全恢复；恢复前快照保存在 state/backups。"
        }
      }
    ]
  }
}
