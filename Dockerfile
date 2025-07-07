FROM node:20-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        mesa-common-dev \
        libxi-dev \
        python-is-python3 \
        pkg-config \
        git \
        libgl1-mesa-dev \
        libglu1-mesa-dev \
        libglew-dev \
        libx11-dev \
        make \
        g++ \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files from GitHub repository
COPY render-socket/package*.json ./

# Install dependencies (uses published kromosynth package from npm)
RUN npm ci --omit=dev

# Copy application code
COPY render-socket/ .

# Production stage
FROM node:20-slim

# Install only runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        mesa-common-dev \
        libxi-dev \
        python-is-python3 \
        libasound2 \
        curl \
        libgl1-mesa-dev \
        libglu1-mesa-dev \
        libglew-dev \
        libx11-dev \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy asound.conf for audio support
COPY render-socket/asound.conf /etc/asound.conf

WORKDIR /app

# Copy built application from builder stage
COPY --from=builder /app .

# Expose the port
EXPOSE 3000

# Command to run the PCM server
CMD ["node", "socket-server-pcm.js"]
