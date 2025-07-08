#!/bin/bash

# Comprehensive startup script for kromosynth services

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if Docker is running
check_docker() {
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker and try again."
        exit 1
    fi
}

# Function to check if Docker Compose is available
check_docker_compose() {
    if command -v docker-compose &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker-compose"
    elif docker compose version &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker compose"
    else
        print_error "Docker Compose not found. Please install Docker Compose."
        exit 1
    fi
}

# Function to start services
start_services() {
    local compose_file=$1
    local description=$2
    
    print_status "Starting $description..."
    print_status "Using compose file: $compose_file"
    
    if [ ! -f "$compose_file" ]; then
        print_error "Compose file $compose_file not found!"
        exit 1
    fi
    
    $DOCKER_COMPOSE_CMD -f "$compose_file" up --build
}

# Main script
main() {
    print_status "Kromosynth Services Startup Script"
    print_status "===================================="
    
    check_docker
    check_docker_compose
    
    print_status "Available startup options:"
    echo "1. GitHub-based build (both repos from GitHub)"
    echo "2. Local development (requires both repos cloned locally)"
    echo "3. Render only (from GitHub)"
    echo "4. Help"
    
    read -p "Choose an option (1-4): " choice
    
    case $choice in
        1)
            if [ -f "docker-compose.full.yml" ]; then
                start_services "docker-compose.full.yml" "services from GitHub repositories"
            else
                print_error "docker-compose.full.yml not found!"
                exit 1
            fi
            ;;
        2)
            if [ -f "docker-compose.local.yml" ]; then
                print_warning "Make sure both repositories are cloned:"
                print_warning "- kromosynth-render (current directory)"
                print_warning "- kromosynth-evoruns (../kromosynth-evoruns)"
                read -p "Continue? (y/N): " confirm
                if [[ $confirm =~ ^[Yy]$ ]]; then
                    start_services "docker-compose.local.yml" "local development services"
                fi
            else
                print_error "docker-compose.local.yml not found!"
                exit 1
            fi
            ;;
        3)
            if [ -f "docker-compose.github.yml" ]; then
                print_warning "This will start only the render service (you need evoruns running separately)"
                start_services "docker-compose.github.yml" "render service only"
            else
                print_error "docker-compose.github.yml not found!"
                exit 1
            fi
            ;;
        4)
            cat << EOF

Usage: $0

This script helps you start the kromosynth services in different configurations:

1. GitHub-based build:
   - Builds both services from their GitHub repositories
   - No local repositories required
   - Uses docker-compose.full.yml

2. Local development:
   - Uses locally cloned repositories
   - Requires both kromosynth-render and kromosynth-evoruns to be cloned
   - kromosynth-evoruns should be in ../kromosynth-evoruns
   - Uses docker-compose.local.yml

3. Render only:
   - Starts only the render service from GitHub
   - You need to run evoruns separately
   - Uses docker-compose.github.yml

Environment Variables:
- EVORUNS_SERVER_URL: URL for the evoruns server (default: http://kromosynth-evoruns:3004)
- PORT: Port for services (render: 3000, evoruns: 3004)
- NODE_ENV: Environment mode (development/production)

Manual usage:
$DOCKER_COMPOSE_CMD -f <compose-file> up --build

EOF
            ;;
        *)
            print_error "Invalid option. Please choose 1-4."
            exit 1
            ;;
    esac
}

main "$@"
