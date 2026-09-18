# ZEWAY MT100 Live Server

Node.js backend for Kingwo MT100 / HQ20-family trackers.

## Ports
- HTTP API: environment variable `PORT`
- Raw tracker TCP: environment variable `TCP_PORT` (default 7001)

For Railway, expose the HTTP service normally and add a TCP Proxy for `TCP_PORT`.

## Required environment variables
- `TCP_PORT=7001`
- `DEVICE_ALIASES=866777078438179:862509128002850`
- `ENABLE_RELAY=false`

## Health
- GET `/health`
- GET `/api/devices`
- GET `/api/devices/:id/live`
- GET `/api/devices/:id/packets`
- GET `/api/devices/:id/trips`

## Commands
POST `/api/devices/:id/commands`
Body examples:
- `{"command":"locate"}`
- `{"command":"set_30s_interval"}`

Lock/unlock is intentionally disabled until `ENABLE_RELAY=true` is set after parked-vehicle verification.
