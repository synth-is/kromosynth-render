# KromoSynth Render - Parallel Processing Implementation

This WebSocket server implements parallel audio rendering using Node.js Worker Threads. The implementation allows the server to utilize multiple CPU cores to process audio rendering requests concurrently.

## Implementation Details

### Worker Thread Pool

- A pool of worker threads is created at startup, with the number of workers equal to the available CPU cores.
- Each worker thread runs in a separate thread and can perform CPU-intensive audio rendering operations independently.
- The main thread manages task distribution and handles client communication.

### Task Queue

- Rendering requests are placed in a queue when all workers are busy.
- As workers become available, they pick up tasks from the queue in FIFO order.
- This ensures efficient resource utilization and prevents overloading the system.

### Worker Thread Recovery

- The system automatically detects and replaces crashed worker threads.
- If a worker encounters an error, it's replaced with a new worker to maintain the pool size.

## Benefits

- **Increased Throughput**: The server can handle multiple rendering requests simultaneously.
- **Improved Responsiveness**: The main thread remains responsive to new client connections.
- **Efficient Resource Utilization**: All available CPU cores are utilized for audio rendering.
- **Scalability**: The number of workers scales automatically with the available hardware.

## Health Check Endpoint

The server includes a `/health` endpoint that provides:
- Server status
- Total number of worker threads
- Currently available workers
- Number of busy workers

## Starting the Server

```bash
npm start
```

The server will display the number of worker threads created based on your system's CPU cores.
