# Kromosynth Render Socket

WebSocket service for real-time progressive audio rendering.

## Features

- ✨ Real-time progressive audio streaming
- 🚀 Optimized for low latency (target: <1s to first audio with server optimizations)
- 📡 WebSocket-based API
- 🌐 Works with Node.js clients and web browsers
- 🎵 Perfect parity with batch renderer

## Installation

```bash
npm install
```

## Usage

### Start Server

```bash
npm start
```

Server listens on `ws://localhost:8080` by default.

### Environment Variables

- `PORT` - WebSocket server port (default: 8080)
- `DB_PATH` - Path to genomes SQLite database
- `KROMOSYNTH_PATH` - Path to kromosynth package (default: ../../kromosynth)

### Test with Node.js Client

```bash
node src/test-client.js [genomeId] [duration]
```

Examples:
```bash
# 5-second render
node src/test-client.js 01JF2N9RZ07V06EJ4DJ9ZGCM2D 5

# 10-second render
node src/test-client.js 01JF2N9RZ07V06EJ4DJ9ZGCM2D 10
```

## Protocol

### Client → Server

```javascript
{
  type: 'render',
  genomeId: '01JF2N9RZ07V06EJ4DJ9ZGCM2D',
  duration: 10,
  noteDelta: 0,    // Pitch shift in semitones
  velocity: 0.5,   // 0.0 - 1.0
  useGPU: true     // Enable GPU acceleration
}
```

### Server → Client

**Welcome:**
```javascript
{
  type: 'welcome',
  message: 'Connected to Kromosynth Render Socket',
  sampleRate: 48000
}
```

**Audio Chunk:**
```javascript
{
  type: 'chunk',
  index: 42,
  data: [0.1, 0.2, ...],  // Float32Array as regular array
  timestamp: 1.5,          // Position in seconds
  sampleRate: 48000
}
```

**Complete:**
```javascript
{
  type: 'complete',
  totalChunks: 100,
  totalSamples: 480000,
  duration: 10,
  sampleRate: 48000
}
```

**Error:**
```javascript
{
  type: 'error',
  message: 'Error description'
}
```

## Performance

### Current
- **Latency**: ~1.6s to first audio chunk
- **Breakdown**:
  - AudioWorklet loading: ~27ms (required on offlineContext, cannot be pre-loaded)
  - CPPN init + audio graph: ~1.53s (genome-specific)

### Server Optimizations (Implemented)
- ✅ **Warm AudioContext**: Reuses AudioContext instance for CPPN GPU computation across requests
- Note: AudioWorklet cannot be pre-loaded (must be loaded on fresh offlineContext for each render)

### Future Optimizations (Potential)
- **CPPN caching**: Cache initialized networks for popular genomes (~1s savings)
- **Audio graph pooling**: Pre-build common audio graph structures
- **Parallel CPPN init**: Initialize CPPNs in parallel for multi-frequency genomes
- **Target**: <500ms to first audio for cached genomes

## Architecture

```
┌─────────────┐      WebSocket      ┌──────────────┐
│  Client     │ ←──────────────────→ │ Server       │
│  (Browser/  │   Audio Chunks       │ (Node.js)    │
│   Node.js)  │                      └──────────────┘
└─────────────┘                             │
                                            ↓
                                     ┌──────────────┐
                                     │ Streaming    │
                                     │ Renderer     │
                                     └──────────────┘
```

## License

MIT
