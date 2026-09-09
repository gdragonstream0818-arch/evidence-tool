#!/bin/sh

set -e

export DISPLAY=:99

echo "Starting virtual display..."

Xvfb :99 \
  -screen 0 1280x900x24 \
  -ac \
  +extension GLX \
  +render \
  -noreset &

sleep 2

echo "Starting VNC server..."

x11vnc \
  -display :99 \
  -forever \
  -shared \
  -nopw \
  -rfbport 5900 \
  -listen 127.0.0.1 &

sleep 2

echo "Starting Node server..."

node server.js
