#!/bin/bash

# Development startup script for kromosynth-render

# Check if Docker Compose is available
if command -v docker-compose &> /dev/null; then
    echo "Starting services with Docker Compose..."
    docker-compose up --build
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    echo "Starting services with Docker Compose (v2)..."
    docker compose up --build
else
    echo "Docker Compose not found. Please install Docker Compose."
    exit 1
fi
