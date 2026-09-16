#!/bin/bash

# Docker Hub Push Script for PageCaster
# Builds and pushes the image to Docker Hub.
#
# Usage:
#   ./docker-push.sh [version]
#   ./docker-push.sh -v <version>
#   ./docker-push.sh -u <dockerhub-username> [-v <version>]
#
# Defaults:
#   DOCKER_USERNAME -> jaashy (override with -u or DOCKER_USERNAME env)
#   VERSION         -> latest

set -e  # Exit on error

print_usage() {
    echo "Usage: ./docker-push.sh [version]"
    echo "       ./docker-push.sh -v <version>"
    echo "       ./docker-push.sh -u <dockerhub-username> [-v <version>]"
    echo ""
    echo "Examples:"
    echo "  ./docker-push.sh v1.4.3"
    echo "  ./docker-push.sh 1.4.3"
    echo "  ./docker-push.sh -u jaashy -v 1.4.3"
    echo ""
}

looks_like_version() {
    [[ "$1" =~ ^v?[0-9]+(\.[0-9]+){0,2}([.-][A-Za-z0-9]+)?$ ]]
}

is_valid_docker_username() {
    [[ "$1" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]]
}

DOCKER_USERNAME="${DOCKER_USERNAME:-jaashy}"
VERSION="latest"
POSITIONAL=()

while [ $# -gt 0 ]; do
    case "$1" in
        -u|--username)
            if [ -z "${2:-}" ]; then
                echo "❌ Error: Missing value for $1"
                print_usage
                exit 1
            fi
            DOCKER_USERNAME="$2"
            shift 2
            ;;
        -v|--version)
            if [ -z "${2:-}" ]; then
                echo "❌ Error: Missing value for $1"
                print_usage
                exit 1
            fi
            VERSION="$2"
            shift 2
            ;;
        -h|--help)
            print_usage
            exit 0
            ;;
        -*)
            echo "❌ Error: Unknown option: $1"
            print_usage
            exit 1
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

if [ ${#POSITIONAL[@]} -gt 1 ]; then
    echo "❌ Error: Too many positional arguments"
    print_usage
    exit 1
fi

if [ ${#POSITIONAL[@]} -eq 1 ]; then
    if looks_like_version "${POSITIONAL[0]}"; then
        VERSION="${POSITIONAL[0]}"
    else
        DOCKER_USERNAME="${POSITIONAL[0]}"
    fi
fi

if ! is_valid_docker_username "$DOCKER_USERNAME"; then
    echo "❌ Error: Invalid Docker Hub username '$DOCKER_USERNAME'"
    exit 1
fi

if [[ "$VERSION" == -* ]]; then
    echo "❌ Error: Invalid version/tag '$VERSION'"
    print_usage
    exit 1
fi

# Configuration
IMAGE="$DOCKER_USERNAME/pagecaster"

echo "=========================================="
echo "Building and Pushing Docker Image"
echo "=========================================="
echo "Docker Hub Username: $DOCKER_USERNAME"
echo "Image: $IMAGE"
echo "Version: $VERSION"
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Error: Docker is not running"
    exit 1
fi

# Build the image
echo "🔨 Building image..."
docker build --platform linux/amd64 -t "$IMAGE:$VERSION" -t "$IMAGE:latest" .
echo "✅ Image built successfully"

# Login to Docker Hub (if not already logged in)
echo ""
echo "🔐 Checking Docker Hub authentication..."
_docker_config="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
_logged_in=false
if [ -f "$_docker_config" ]; then
    if grep -q '"https://index.docker.io/v1/"' "$_docker_config" 2>/dev/null; then
        _logged_in=true
    elif grep -q '"credsStore"' "$_docker_config" 2>/dev/null || grep -q '"credHelpers"' "$_docker_config" 2>/dev/null; then
        _logged_in=true
    fi
fi
if [ "$_logged_in" = false ]; then
    echo "Please login to Docker Hub:"
    docker login
fi

# Push the image
echo ""
echo "📤 Pushing image to Docker Hub..."
docker push "$IMAGE:$VERSION"
docker push "$IMAGE:latest"
echo "✅ Image pushed successfully"

echo ""
echo "=========================================="
echo "✅ Image built and pushed!"
echo "=========================================="
echo ""
echo "Images pushed:"
echo "  - $IMAGE:$VERSION"
echo "  - $IMAGE:latest"
echo ""
echo "To pull this image:"
echo "  docker pull $IMAGE:latest"
echo ""
