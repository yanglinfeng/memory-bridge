module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        bluefairy: "off",
        message: [
          "node bundle/scripts/memory-bridge-lifecycle.mjs uninstall --source bundle --install-root app --state-dir state",
          "node bundle/scripts/memory-bridge-lifecycle.mjs install --source bundle --install-root app --state-dir state"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "忆桥程序已修复重装；用户数据未删除。"
      }
    }
  ]
}
