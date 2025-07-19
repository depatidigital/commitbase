#!/bin/bash

APP_NAME="app-a"
APP_DIR="/opt/commitbase-apps/$APP_NAME"
PM2_CONFIG="$APP_DIR/pm2.config.js"
SOCKET_PATH="/run/$APP_NAME.sock"

# Remove old socket if exists
[ -e "$SOCKET_PATH" ] && rm "$SOCKET_PATH"

# Run Firejail in background with PM2
echo "[*] Launching $APP_NAME inside Firejail..."
firejail \
  --name=$APP_NAME \
  --net=bridge \
  --private \
  --whitelist=$APP_DIR \
  --cwd=$APP_DIR \
  bash -c "cd $APP_DIR && pm2 start $PM2_CONFIG" &

# Give it a few seconds to initialize (or use pm2 status check if needed)
sleep 3

# Forward 127.0.0.1:3000 to UNIX socket
echo "[*] Forwarding 127.0.0.1:3000 → $SOCKET_PATH ..."
firejail --join=$APP_NAME \
  socat UNIX-LISTEN:$SOCKET_PATH,fork TCP:127.0.0_
