# KromoSynth Render with PM2 Clustering

This repository now includes PM2 cluster support, allowing the rendering server to utilize multiple CPU cores efficiently.

## What is PM2?

PM2 is a production process manager for Node.js applications with a built-in load balancer. It allows you to keep applications alive forever, reloads them without downtime, and facilitates common system admin tasks.

## How PM2 Clustering Works

The PM2 cluster mode automatically launches multiple instances of your application to distribute the load across all available CPU cores. Each instance is a complete Node.js process with its own memory space, but all instances share the same server port.

This approach has several advantages over worker threads for our application:

1. Each process has its own memory space, preventing GPU/WebGL context conflicts
2. Full isolation between processes, improving stability
3. Automatic load balancing across processes
4. Zero-downtime reloads and crash recovery

## Configuration

The clustering setup is configured through the `ecosystem.config.js` file at the root of the project:

```javascript
module.exports = {
  apps: [
      {
          name: "kromosynth-render",
          script: "socket-server-pcm.js",
          instances: "max",  // Uses all available CPU cores
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
```

### Key Settings:

- `instances: "max"`: Automatically creates one process per CPU core
- `exec_mode: "cluster"`: Enables the cluster mode for load balancing
- `autorestart: true`: Automatically restarts processes if they crash

## Running with Docker Compose

When using Docker Compose, the application will automatically run in PM2 cluster mode:

```bash
# From the kromosynth-services directory
docker compose up --build
```

## Monitoring

PM2 provides monitoring capabilities that can be useful for debugging and performance analysis. 

When running in a Docker container, you can view the PM2 monitor by executing:

```bash
docker exec -it <container_id> pm2 monit
```

For more PM2 commands and options, see the [PM2 documentation](https://pm2.keymetrics.io/docs/usage/pm2-doc-single-page/).
