# Docker Setup for kromosynth-render

This project includes Docker and Docker Compose configurations for easy deployment and development.

## Quick Start

### Using Docker Compose (Recommended)

1. **Build and start all services:**
   ```bash
   docker-compose up --build
   ```

2. **Run in detached mode:**
   ```bash
   docker-compose up -d --build
   ```

3. **Stop services:**
   ```bash
   docker-compose down
   ```

### Using the startup script

```bash
./start-services.sh
```

## Configuration

### Dockerfiles

The project includes two Dockerfiles:

- **`Dockerfile`** - Root-level Dockerfile for GitHub builds and external references
  - Handles the local `kromosynth` dependency correctly
  - Uses multi-stage build to compile native dependencies like `gl`
  - Includes all necessary build tools
- **`render-socket/Dockerfile.pcm`** - Local development Dockerfile with render-socket as build context

**Important:** The GitHub Dockerfile handles the local file dependency `"kromosynth": "file:../../kromosynth"` by copying the entire repository first, then building from the render-socket directory.

### Environment Variables

The following environment variables can be configured:

- `PORT` - Port for the WebSocket server (default: 3000)

### Docker Compose Services

- **kromosynth-render** - The main PCM WebSocket server
- **second-service** - (Template) Add your second service here

## Development

### Local Development vs Docker

For local development, you can still run:
```bash
cd render-socket
node socket-server-pcm.js --port 3000
```

For containerized development:
```bash
docker-compose up --build
```

### Adding Services

To add another service to the Docker Compose setup:

1. Edit `docker-compose.yml`
2. Add your service configuration
3. Update the network configuration if needed

Example service addition:
```yaml
  your-service:
    image: your-service:latest
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
    depends_on:
      - kromosynth-render
    networks:
      - kromosynth-network
```

## Deployment

### GitHub Integration

The `docker-compose.github.yml` can reference this repository for automated builds:

```yaml
  kromosynth-render:
    build:
      context: https://github.com/synth-is/kromosynth-render.git
      dockerfile: Dockerfile
```

**Note:** When building from GitHub, use the root-level `Dockerfile`, not `render-socket/Dockerfile.pcm`.

### Production Considerations

- Use specific image tags instead of `latest`
- Set up proper volume mounts for persistent data
- Configure proper environment variables for production
- Set up health checks
- Use secrets for sensitive configuration

## Troubleshooting

### Common Issues

1. **Port conflicts**: Change the port mapping in `docker-compose.yml`
2. **Build failures**: Ensure all dependencies are correctly specified
3. **Audio issues**: The `asound.conf` file handles audio configuration in the container

### Logs

View logs for all services:
```bash
docker-compose logs -f
```

View logs for specific service:
```bash
docker-compose logs -f kromosynth-render
```
