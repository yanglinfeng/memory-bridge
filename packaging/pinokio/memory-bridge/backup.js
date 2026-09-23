module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        message: [
          "node bundle/scripts/memory-bridge-lifecycle.mjs backup --source bundle --install-root app --state-dir state"
        ]
      }
    },
    {
      method: "notify",
      params: {
        html: "忆桥一致性备份已完成；数据库与 SHA-256 manifest 保存在 state/backups。"
      }
    }
  ]
}
