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

# Copy the entire repository (needed for local kromosynth dependency)
COPY . .

# Navigate to render-socket directory
WORKDIR /app/render-socket

# Install dependencies (this will resolve the local kromosynth dependency)
RUN npm ci

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
COPY --from=builder /app/render-socket .

# Expose the port
EXPOSE 3000

# Command to run the PCM server
CMD ["node", "socket-server-pcm.js"]
