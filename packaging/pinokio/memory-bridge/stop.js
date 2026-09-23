const path = require("path")

function runtimeIdentity(kernel) {
  const startScript = path.resolve(__dirname, "start.js")
  const appRoot = path.resolve(__dirname, "app")
  const local = kernel.memory?.local?.[startScript] || {}
  const pid = Number(local.pid)
  const cwd = path.resolve(String(local.cwd || ""))
  const group = String(local.group || "")
  const port = Number(local.port)
  let readyUrl
  try {
    readyUrl = new URL(String(local.url))
  } catch {
    throw new Error("缺少受管服务 ready URL；未知 owner，拒绝停止。")
  }
  if (
    !Number.isInteger(pid) ||
    pid < 1 ||
    cwd !== appRoot ||
    group !== startScript ||
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
    throw new Error("受管服务 PID/cwd/group/loopback 身份不匹配；未知 owner，拒绝停止。")
  }
  return { startScript, pid, cwd, group, readyUrl: readyUrl.toString() }
}

module.exports = async (kernel) => {
  if (!await kernel.running(__dirname, "start.js")) {
    throw new Error("忆桥服务未运行，无需停止。")
  }
  const runtime = runtimeIdentity(kernel)
  const ownership = [
    "node bundle/scripts/memory-bridge-lifecycle.mjs stop",
    "--phase preflight",
    "--source bundle",
    "--install-root app",
    "--state-dir state",
    `--pid ${runtime.pid}`,
    `--cwd ${JSON.stringify(runtime.cwd)}`,
    `--ready-url ${JSON.stringify(runtime.readyUrl)}`,
  ].join(" ")
  return {
    run: [
      {
        method: "shell.run",
        params: { message: [ownership] }
      },
      {
        method: "shell.stop",
        params: { group: runtime.group }
      },
      {
        method: "shell.run",
        params: {
          message: [
            `${ownership.replace("--phase preflight", "--phase postflight")} --verify-stopped --receipt-file state/receipts/stop-postflight.latest.json`
          ]
        }
      },
      {
        method: "notify",
        params: { html: "忆桥服务已安全停止。" }
      }
    ]
  }
}
