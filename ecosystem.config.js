module.exports = {
  apps: [
      {
          name: "kromosynth-render",
          script: "socket-server-pcm.js",
          instances: "max",
          exec_mode: "cluster",
          autorestart: true,
          watch: false,
          max_memory_restart: "1G",
          env: {
              NODE_ENV: "production"
          }
      }
  ]
}