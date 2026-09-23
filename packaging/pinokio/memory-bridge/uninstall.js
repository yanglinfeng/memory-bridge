module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        message: [
          "node bundle/scripts/memory-bridge-lifecycle.mjs uninstall --source bundle --install-root app --state-dir state"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "忆桥程序已卸载，state/data 中的用户数据仍然保留。"
      }
    }
  ]
}
