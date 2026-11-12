module.exports = {
  run: [{
    when: "{{!which('ffmpeg') || !which('ffprobe')}}",
    method: "shell.run",
    params: {
      message: 'conda install -y -c conda-forge "ffmpeg=*=*gpl*"'
    }
  }, {
    method: "shell.run",
    params: {
      path: "app",
      env: {
        FFMPEG_PATH: "{{which('ffmpeg')}}",
        FFPROBE_PATH: "{{which('ffprobe')}}"
      },
      message: '"{{which(\'node\')}}" setup.mjs'
    }
  }]
}
