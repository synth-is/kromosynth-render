# Dockerfile for kromosynth-evoruns
# This file should be placed in the root of the kromosynth-evoruns repository

FROM node:20-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl \
        && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

# Create health check endpoint script if it doesn't exist
RUN echo 'const http = require("http"); \
const options = { hostname: "localhost", port: process.env.PORT || 3004, path: "/health", timeout: 2000 }; \
const req = http.request(options, (res) => { \
  if (res.statusCode === 200) process.exit(0); else process.exit(1); \
}); \
req.on("error", () => process.exit(1)); \
req.on("timeout", () => process.exit(1)); \
req.end();' > /app/health-check.js

# Expose the port
EXPOSE 3004

# Add health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node /app/health-check.js

# Command to run the server
CMD ["node", "evorun-browser-server.js"]
