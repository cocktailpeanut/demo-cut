module.exports = {
  daemon: true,
  run: [{
    method: "shell.run",
    params: {
      path: "app",
      env: {
        PORT: "{{port}}",
        FFMPEG_PATH: "{{which('ffmpeg')}}",
        FFPROBE_PATH: "{{which('ffprobe')}}"
      },
      message: '"{{which(\'node\')}}" server.mjs',
      on: [{
        event: "/(http:\\/\\/[0-9.:]+)/",
        done: true
      }]
    }
  }, {
    method: "local.set",
    params: {
      url: "{{input.event[1]}}"
    }
  }]
}
