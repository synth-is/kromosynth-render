module.exports = {
  apps: [
      {
          script: "render-socket/socket-server-pcm.js",
          instances: "-2",
          exec_mode: "cluster",
          autorestart: true,
      }
  ]
}