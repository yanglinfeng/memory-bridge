const path = require("path")

module.exports = {
  version: "7.0",
  title: "忆桥 Memory Bridge",
  description: "本地优先、支持多用户与多角色隔离的长期记忆 MCP 服务。",
  menu: async (kernel) => {
    const installing = await kernel.running(__dirname, "install.js")
    const updating = await kernel.running(__dirname, "update.js")
    const installed = await kernel.exists(__dirname, "app", "dist", "server", "index.js")
    const running = await kernel.running(__dirname, "start.js")

    if (installing || updating) {
      return [{
        default: true,
        icon: "fa-solid fa-gears",
        text: installing ? "正在安装" : "正在升级",
        href: installing ? "install.js" : "update.js"
      }]
    }
    if (!installed) {
      return [{
        default: true,
        icon: "fa-solid fa-plug",
        text: "一键安装",
        href: "install.js"
      }, {
        icon: "fa-solid fa-stethoscope",
        text: "故障诊断",
        href: "doctor.js"
      }]
    }
    if (running) {
      const local = kernel.memory.local[path.resolve(__dirname, "start.js")]
      const menu = []
      if (local && local.url) {
        menu.push({
          default: true,
          icon: "fa-solid fa-rocket",
          text: "打开管理界面",
          href: local.url
        })
      }
      menu.push({
        default: !(local && local.url),
        icon: "fa-solid fa-terminal",
        text: "运行日志",
        href: "start.js"
      }, {
        icon: "fa-solid fa-power-off",
        text: "安全停止",
        href: "stop.js"
      }, {
        icon: "fa-solid fa-box-archive",
        text: "备份记忆库",
        href: "backup.js"
      }, {
        icon: "fa-solid fa-stethoscope",
        text: "故障诊断",
        href: "doctor.js"
      })
      return menu
    }
    return [{
      default: true,
      icon: "fa-solid fa-power-off",
      text: "启动",
      href: "start.js"
    }, {
      icon: "fa-solid fa-arrow-up",
      text: "安全升级",
      href: "update.js"
    }, {
      icon: "fa-solid fa-box-archive",
      text: "备份记忆库",
      href: "backup.js"
    }, {
      icon: "fa-solid fa-clock-rotate-left",
      text: "从备份恢复",
      href: "restore.js"
    }, {
      icon: "fa-solid fa-link",
      text: "生成 MCP 配置",
      href: "mcp-config.js"
    }, {
      icon: "fa-solid fa-stethoscope",
      text: "故障诊断",
      href: "doctor.js"
    }, {
      icon: "fa-solid fa-screwdriver-wrench",
      text: "保留数据修复重装",
      href: "reset.js"
    }, {
      icon: "fa-regular fa-circle-xmark",
      text: "卸载程序（保留数据）",
      href: "uninstall.js"
    }]
  }
}
