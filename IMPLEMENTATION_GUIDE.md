# KromoSynth Render: Single-Threaded vs. Parallel Implementation

This project provides two implementations of the KromoSynth rendering server:

1. **Standard single-threaded implementation** (`socket-server-pcm.js`)
2. **Parallel multi-threaded implementation** (`socket-server-pcm-parallel.js`)

## Running Locally

### Standard Implementation
```bash
cd render-socket
npm start
# or
npm run dev
```

### Parallel Implementation
```bash
cd render-socket
npm run start:parallel
# or
npm run dev:parallel
```

## Docker Deployment

### Using the Flexible Dockerfile

The `Dockerfile.flexible` allows you to choose which implementation to run using an environment variable:

```bash
# Build with flexible Dockerfile
docker build -f render-socket/Dockerfile.flexible -t kromosynth-render .

# Run standard implementation (default)
docker run -p 3000:3000 kromosynth-render

# Run parallel implementation
docker run -p 3000:3000 -e SERVER_IMPLEMENTATION=socket-server-pcm-parallel.js kromosynth-render
```

### Using Docker Compose

You can also use Docker Compose to run either or both implementations:

```bash
# Run the default implementation (single-threaded)
docker-compose up

# Run using the parallel configuration
docker-compose -f docker-compose.parallel.yml up

# Run only the parallel version
docker-compose -f docker-compose.parallel.yml up kromosynth-render-parallel
```

## Choosing the Right Implementation

- **Standard Implementation**: Good for development, debugging, and lower-traffic scenarios
- **Parallel Implementation**: Better for production and high-traffic scenarios where performance is critical

## Performance Comparison

The parallel implementation should provide better performance in these scenarios:

1. Multiple clients making concurrent requests
2. Complex rendering tasks that benefit from parallel processing
3. Systems with multiple CPU cores (the more cores, the better the improvement)

## Health Check Endpoint

Both implementations provide a `/health` endpoint:

- **Standard**: `http://localhost:3000/health`
- **Parallel**: `http://localhost:3000/health` (includes worker status info)

For the parallel implementation, the health check shows worker pool statistics.
