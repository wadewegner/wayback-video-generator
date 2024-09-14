#!/bin/bash

# Function to install FFmpeg on Debian-based systems (Ubuntu, Debian, etc.)
install_ffmpeg_debian() {
    echo "Updating package lists..."
    sudo apt-get update
    echo "Installing FFmpeg..."
    sudo apt-get install -y ffmpeg
}

# Function to install FFmpeg on Red Hat-based systems (CentOS, Fedora, etc.)
install_ffmpeg_redhat() {
    echo "Installing EPEL repository..."
    sudo yum install -y epel-release
    echo "Installing FFmpeg..."
    sudo yum install -y ffmpeg
}

# Function to install FFmpeg on macOS using Homebrew
install_ffmpeg_macos() {
    if ! command -v brew &> /dev/null; then
        echo "Homebrew not found. Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    echo "Installing FFmpeg..."
    brew install ffmpeg
}

# Detect the operating system
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    if [ -f /etc/debian_version ]; then
        install_ffmpeg_debian
    elif [ -f /etc/redhat-release ]; then
        install_ffmpeg_redhat
    else
        echo "Unsupported Linux distribution. Please install FFmpeg manually."
        exit 1
    fi
elif [[ "$OSTYPE" == "darwin"* ]]; then
    install_ffmpeg_macos
else
    echo "Unsupported operating system. Please install FFmpeg manually."
    exit 1
fi

# Check if FFmpeg was installed successfully
if command -v ffmpeg &> /dev/null; then
    echo "FFmpeg has been successfully installed!"
    ffmpeg -version
else
    echo "Failed to install FFmpeg. Please try installing it manually."
    exit 1
fi
