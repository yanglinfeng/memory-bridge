module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        bluefairy: "off",
        message: [
          "node bundle/scripts/memory-bridge-lifecycle.mjs install --source bundle --install-root app --state-dir state"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "忆桥安装完成。数据位于 state/data，后续升级和卸载默认都会保留。"
      }
    }
  ]
}
