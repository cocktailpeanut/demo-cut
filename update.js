module.exports = {
  run: [{
    method: "shell.run",
    params: {
      path: "app",
      message: '"{{which(\'node\')}}" update.mjs'
    }
  }, {
    method: "script.start",
    params: {
      uri: "install.js"
    }
  }]
}
