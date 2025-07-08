# KromoSynth Render - Audio Rendering Server

This folder contains the WebSocket server implementations for KromoSynth audio rendering:

## Server Implementations

### Standard Single-threaded Server (socket-server-pcm.js)
- Default implementation that processes audio rendering requests sequentially
- Simple and stable architecture
- Best for development or low traffic scenarios

### Parallel Multi-threaded Server (socket-server-pcm-parallel.js)
- Uses Node.js Worker Threads to parallelize audio rendering
- Creates a worker pool based on available CPU cores
- Implements a task queue system for high-traffic scenarios
- Best for production or high-traffic scenarios where performance is critical

## Running the Server

### Standard Single-threaded Version
```bash
npm start
# or
npm run dev  # for development with custom port
```

### Parallel Multi-threaded Version
```bash
npm run start:parallel
# or
npm run dev:parallel  # for development with custom port
```

## Configuration

Both servers accept the same environment variables:
- `PORT`: The port to listen on (default: 3000)
- `EVORUNS_SERVER_URL`: The URL of the evoruns server (default: http://localhost:3004)

## Health Check Endpoint

Both servers provide a `/health` endpoint:
- Standard server returns basic status information
- Parallel server additionally reports worker thread status

## Worker Thread Details (Parallel Version Only)

The parallel implementation creates worker threads equal to the number of CPU cores available on the system, allowing for true parallel processing of audio rendering requests across multiple CPU cores.

For more details on the parallel processing implementation, see [PARALLEL_PROCESSING.md](./PARALLEL_PROCESSING.md).
