module.exports = {
  version: "7.0",
  title: "Demo Cut",
  description: "Turn screen recordings into focused demos with smooth zooms and local MP4 export.",
  icon: "icon.svg",
  menu: async (kernel, info) => {
    const installed = info.exists("app/.installed")
    for (const [script, text] of [
      ["install.js", "Installing"],
      ["update.js", "Updating"],
      ["reset.js", "Resetting"]
    ]) {
      if (info.running(script)) {
        return [{ default: true, icon: "fa-solid fa-terminal", text, href: script }]
      }
    }
    if (info.running("start.js")) {
      const local = info.local("start.js")
      if (local && local.url) {
        return [{
          default: true,
          icon: "fa-solid fa-arrow-up-right-from-square",
          text: "Open Demo Cut",
          href: local.url
        }, {
          icon: "fa-solid fa-terminal",
          text: "Terminal",
          href: "start.js"
        }]
      }
      return [{ default: true, icon: "fa-solid fa-terminal", text: "Starting", href: "start.js" }]
    }
    if (!installed) {
      return [{ default: true, icon: "fa-solid fa-plug", text: "Install", href: "install.js" }]
    }
    return [{
      default: true,
      icon: "fa-solid fa-play",
      text: "Start",
      href: "start.js"
    }, {
      icon: "fa-solid fa-rotate",
      text: "Update",
      href: "update.js"
    }, {
      icon: "fa-solid fa-plug",
      text: "Install",
      href: "install.js"
    }, {
      icon: "fa-solid fa-arrow-rotate-left",
      text: "Reset setup",
      href: "reset.js"
    }]
  }
}
