module.exports = async (kernel) => {
  const serviceRunning = await kernel.running(__dirname, "start.js")
  if (serviceRunning) {
    throw new Error("忆桥服务运行中，拒绝升级；请先使用“安全停止”，确认停止后再升级。")
  }
  return {
    run: [
    {
      method: "shell.run",
      params: {
        message: ["node update-source.js"]
      }
    },
    {
      method: "shell.run",
      params: {
        bluefairy: "off",
        message: [
          "node bundle/scripts/memory-bridge-lifecycle.mjs upgrade --source bundle --install-root app --state-dir state"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "忆桥升级完成。升级前数据库备份位于 state/backups，旧代码保留为回滚版本。"
      }
    }
    ]
  }
}
