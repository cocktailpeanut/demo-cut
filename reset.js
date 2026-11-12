module.exports = {
  run: [{
    when: "{{exists('app/.installed')}}",
    method: "fs.rm",
    params: {
      path: "app/.installed"
    }
  }]
}
