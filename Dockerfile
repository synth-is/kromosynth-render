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
RUN npm install

# Production stage
FROM node:20-slim

# Build arg to enable/disable PM2
ARG USE_PM2=false

# Install only runtime dependencies and optionally PM2
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
    rm -rf /var/lib/apt/lists/* && \
    if [ "$USE_PM2" = "true" ] ; then npm install -g pm2 ; fi

# Copy asound.conf for audio support
COPY render-socket/asound.conf /etc/asound.conf

WORKDIR /app

# Copy built application from builder stage
COPY --from=builder /app/render-socket .

# Expose the port
EXPOSE 3000

# Copy the ecosystem.config.js file (already has the correct configuration)
COPY --from=builder /app/ecosystem.config.js .

# Command to run the PCM server with PM2 clustering
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
