module.exports = {
  apps: [
      {
          name: "kromosynth-render",
          script: "socket-server-pcm.js",
          instances: process.env.PM2_INSTANCES || "max",
          exec_mode: "cluster",
          autorestart: true,
          watch: false,
          max_memory_restart: "1G",
          env: {
              NODE_ENV: process.env.NODE_ENV || "production",
              PORT: process.env.PORT || 3000,
              EVORUNS_SERVER_URL: process.env.EVORUNS_SERVER_URL || "http://kromosynth-evoruns:3004"
          }
      }
  ]
}
