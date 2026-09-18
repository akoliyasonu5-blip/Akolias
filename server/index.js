const net = require('net');
const http = require('http');
const express = require('express');
const cors = require('cors');

const HTTP_PORT = Number(process.env.PORT || 3000);
const TCP_PORT = Number(process.env.TCP_PORT || 7001);
const ENABLE_RELAY = String(process.env.ENABLE_RELAY || 'false').toLowerCase() === 'true';
const OFFLINE_AFTER_MS = Number(process.env.OFFLINE_AFTER_MS || 5 * 60 * 1000);
const MAX_PACKETS = Number(process.env.MAX_PACKETS || 200);

const app = express();
app.use(cors());
app.use(express.json({ limit: '128kb' }));

const httpServer = http.createServer(app);
const tcpServer = net.createServer();

const devices = new Map();
const socketsByDevice = new Map();
const tripHistory = new Map();
const activeTrips = new Map();

function nowIso() {
  return new Date().toISOString();
}

function parseAliasEnv() {
  const map = new Map();
  const raw = process.env.DEVICE_ALIASES || '';
  for (const pair of raw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, b] = pair.split(':').map(s => (s || '').trim());
    if (!a || !b) continue;
    map.set(a, b);
    map.set(b, a);
  }
  return map;
}
const aliases = parseAliasEnv();

function resolveDeviceKey(requested) {
  if (devices.has(requested)) return requested;
  const alias = aliases.get(requested);
  if (alias && devices.has(alias)) return alias;
  return requested;
}

function getDevice(id) {
  return devices.get(resolveDeviceKey(id));
}

function nibble(ch) {
  if (!ch) return 0;
  return ch.charCodeAt(0) & 0x0f;
}

function parseLatLonGpsField(value) {
  if (!value || value.length < 34) return {};
  try {
    const time = value.slice(0, 6);
    const latRaw = value.slice(6, 14);
    const lonRaw = value.slice(14, 23);
    const flagChar = value.slice(23, 24);
    const speedRaw = value.slice(24, 26);
    const courseRaw = value.slice(26, 28);
    const dateRaw = value.slice(28, 34);

    const latDeg = Number(latRaw.slice(0, 2));
    const latMin = Number(latRaw.slice(2, 4) + '.' + latRaw.slice(4));
    const lonDeg = Number(lonRaw.slice(0, 3));
    const lonMin = Number(lonRaw.slice(3, 5) + '.' + lonRaw.slice(5));

    let latitude = latDeg + latMin / 60;
    let longitude = lonDeg + lonMin / 60;

    const flags = nibble(flagChar);
    const precise = (flags & 0x1) === 0;
    const north = (flags & 0x2) !== 0;
    const east = (flags & 0x4) !== 0;
    if (!north) latitude = -latitude;
    if (!east) longitude = -longitude;

    const speedKph = Number(speedRaw) * 2 * 1.852;
    const heading = Number(courseRaw) * 10;

    const hh = time.slice(0, 2);
    const mm = time.slice(2, 4);
    const ss = time.slice(4, 6);
    const dd = dateRaw.slice(0, 2);
    const mo = dateRaw.slice(2, 4);
    const yy = dateRaw.slice(4, 6);
    let gpsTime = null;
    if (/^\d{6}$/.test(time) && /^\d{6}$/.test(dateRaw)) {
      gpsTime = new Date('20' + yy + '-' + mo + '-' + dd + 'T' + hh + ':' + mm + ':' + ss + 'Z').toISOString();
    }

    return { latitude, longitude, gpsValid: precise, speedKph, heading, gpsTime };
  } catch {
    return {};
  }
}

function parseStatus(value) {
  if (!value || value.length < 10) return {};
  const s0 = nibble(value[0]);
  const s1 = nibble(value[1]);
  const a0 = nibble(value[5]);
  const a1 = nibble(value[6]);
  const a3 = nibble(value[8]);
  return {
    locked: (s0 & 0x2) !== 0,
    gpsModuleError: (s0 & 0x4) !== 0,
    ignition: (s1 & 0x1) !== 0,
    vibrationAlarm: (a0 & 0x4) !== 0,
    movementAlarm: (a0 & 0x8) !== 0,
    overspeedAlarm: (a1 & 0x4) !== 0,
    cableCutAlarm: (a3 & 0x2) !== 0,
    lowVoltageAlarm: (a3 & 0x4) !== 0
  };
}

function parseMileage(value) {
  if (!value || value.length < 8) return null;
  try {
    const hex = [...value.slice(0, 8)].map(c => nibble(c).toString(16)).join('');
    const raw = parseInt(hex, 16);
    if (!Number.isFinite(raw)) return null;
    return raw * 2 * 1.852 / 3600;
  } catch {
    return null;
  }
}

function parseAdditional(raw) {
  const result = {};
  const parts = raw.split('&').slice(1);
  for (const part of parts) {
    if (!part) continue;
    const key = part[0];
    const value = part.slice(1).trim();
    if (key === 'A') Object.assign(result, parseLatLonGpsField(value));
    else if (key === 'B') Object.assign(result, parseStatus(value));
    else if (key === 'C') {
      const km = parseMileage(value);
      if (km != null) result.mileageKm = km;
    } else if (key === 'F' && /^\d{4}/.test(value)) {
      result.speedKph = (Number(value.slice(0, 4)) / 10) * 1.852;
    } else if (key === 'V' && /^\d{4}/.test(value)) {
      result.mainVoltage = Number(value.slice(0, 4)) / 10;
    } else if (key === 'R' && /^\d{4}/.test(value)) {
      result.gsmSignal = Number(value.slice(0, 2));
      result.satellites = Number(value.slice(2, 4));
    } else if (key === 'T' && /^\d{2}/.test(value)) {
      result.backupBatteryPercent = Number(value.slice(0, 2));
    }
  }
  return result;
}

function parsePacket(raw) {
  const clean = raw.trim();
  if (!clean.startsWith('*HQ20') || !clean.endsWith('#')) {
    return { raw: clean, valid: false, reason: 'not_hq20' };
  }

  const comma = clean.indexOf(',');
  if (comma < 0) {
    return { raw: clean, valid: true, deviceId: null, code: clean.includes('ZZ') ? 'ZZ' : null };
  }

  const header = clean.slice(5, comma);
  const digits = (header.match(/\d+/g) || []).join('');
  let deviceId = '';
  if (digits.length > 15) deviceId = digits.slice(-15);
  else if (digits.length > 6) deviceId = digits.slice(2);
  else deviceId = digits;

  let body = clean.slice(comma + 1, -1).trim();
  let isResponse = false;
  if (body.startsWith('Y')) {
    isResponse = true;
    body = body.slice(1);
  }

  const code = body.slice(0, 2);
  const parsed = parseAdditional(body);

  return {
    raw: clean,
    valid: true,
    deviceId,
    code,
    isResponse,
    receivedAt: nowIso(),
    ...parsed
  };
}

function makeAck(code) {
  if (!code || code.length < 2) return null;
  return '*HQ20Y' + code.slice(0, 2) + '#';
}

function publicDevice(d) {
  if (!d) return null;
  const lastMs = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
  const online = Date.now() - lastMs <= OFFLINE_AFTER_MS;
  return {
    deviceId: d.deviceId,
    status: online ? 'online' : 'offline',
    latitude: d.latitude ?? null,
    longitude: d.longitude ?? null,
    speedKph: Number((d.speedKph || 0).toFixed(1)),
    heading: d.heading ?? 0,
    ignition: !!d.ignition,
    mainVoltage: d.mainVoltage ?? null,
    gsmSignal: d.gsmSignal ?? null,
    satellites: d.satellites ?? null,
    gpsValid: d.gpsValid ?? null,
    mileageKm: d.mileageKm != null ? Number(d.mileageKm.toFixed(3)) : null,
    backupBatteryPercent: d.backupBatteryPercent ?? null,
    lastUpdate: d.lastSeen || null,
    lastGpsTime: d.gpsTime || null,
    lastCode: d.lastCode || null,
    remoteAddress: d.remoteAddress || null,
    alerts: d.alerts || {},
    packetCount: d.packetCount || 0
  };
}

function updateTrips(deviceId, previous, current) {
  const speed = Number(current.speedKph || 0);
  const ignition = !!current.ignition;
  const wasIgnition = !!previous?.ignition;
  let active = activeTrips.get(deviceId);

  if (!active && ignition && (!wasIgnition || speed >= 3)) {
    active = {
      id: 'trip-' + Date.now(),
      startTime: current.lastSeen,
      startLatitude: current.latitude ?? null,
      startLongitude: current.longitude ?? null,
      startBatteryVoltage: current.mainVoltage ?? null,
      maxSpeedKph: speed,
      movingSeconds: 0,
      idleSeconds: 0,
      lastSampleAt: Date.now(),
      startMileageKm: current.mileageKm ?? null
    };
    activeTrips.set(deviceId, active);
  }

  if (active) {
    const now = Date.now();
    const delta = Math.max(0, Math.min(300, (now - active.lastSampleAt) / 1000));
    if (ignition && speed >= 3) active.movingSeconds += delta;
    else if (ignition) active.idleSeconds += delta;
    active.maxSpeedKph = Math.max(active.maxSpeedKph || 0, speed);
    active.lastSampleAt = now;

    if (!ignition && wasIgnition) {
      active.endTime = current.lastSeen;
      active.endLatitude = current.latitude ?? null;
      active.endLongitude = current.longitude ?? null;
      active.endBatteryVoltage = current.mainVoltage ?? null;
      active.endMileageKm = current.mileageKm ?? null;
      if (active.startMileageKm != null && active.endMileageKm != null) {
        active.distanceKm = Math.max(0, active.endMileageKm - active.startMileageKm);
      } else {
        active.distanceKm = null;
      }
      const list = tripHistory.get(deviceId) || [];
      list.unshift(active);
      tripHistory.set(deviceId, list.slice(0, 100));
      activeTrips.delete(deviceId);
    }
  }
}

function saveParsed(parsed, socket) {
  if (!parsed.deviceId) return;
  const old = devices.get(parsed.deviceId) || { deviceId: parsed.deviceId, packets: [], packetCount: 0 };
  const prev = { ...old };
  const next = {
    ...old,
    ...Object.fromEntries(Object.entries(parsed).filter(([k, v]) => !['raw', 'valid', 'deviceId', 'code', 'isResponse', 'receivedAt'].includes(k) && v !== undefined)),
    deviceId: parsed.deviceId,
    lastCode: parsed.code,
    lastSeen: parsed.receivedAt || nowIso(),
    remoteAddress: socket ? socket.remoteAddress : old.remoteAddress,
    packetCount: (old.packetCount || 0) + 1
  };

  next.alerts = {
    lowVoltage: !!parsed.lowVoltageAlarm,
    overspeed: !!parsed.overspeedAlarm,
    vibration: !!parsed.vibrationAlarm,
    movement: !!parsed.movementAlarm,
    cableCut: !!parsed.cableCutAlarm,
    gpsModuleError: !!parsed.gpsModuleError
  };

  next.packets = [{ raw: parsed.raw, at: next.lastSeen, code: parsed.code }, ...(old.packets || [])].slice(0, MAX_PACKETS);
  devices.set(parsed.deviceId, next);
  updateTrips(parsed.deviceId, prev, next);
}

tcpServer.on('connection', socket => {
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  socket.setTimeout(10 * 60 * 1000);

  let buffer = '';

  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');

    let idx;
    while ((idx = buffer.indexOf('#')) >= 0) {
      const frame = buffer.slice(0, idx + 1);
      buffer = buffer.slice(idx + 1);

      const start = frame.indexOf('*HQ20');
      if (start < 0) continue;
      const raw = frame.slice(start);
      const parsed = parsePacket(raw);

      if (parsed.deviceId) {
        socketsByDevice.set(parsed.deviceId, socket);
      }
      saveParsed(parsed, socket);

      if (!parsed.isResponse && parsed.code && parsed.code !== 'ZZ') {
        const ack = makeAck(parsed.code);
        if (ack) {
          try { socket.write(ack); } catch {}
        }
      }

      console.log(JSON.stringify({
        type: 'tracker_packet',
        deviceId: parsed.deviceId,
        code: parsed.code,
        remote: socket.remoteAddress,
        raw: parsed.raw
      }));
    }
  });

  socket.on('timeout', () => socket.end());

  socket.on('close', () => {
    for (const [id, s] of socketsByDevice.entries()) {
      if (s === socket) socketsByDevice.delete(id);
    }
  });

  socket.on('error', err => {
    console.error(JSON.stringify({ type: 'tcp_error', message: err.message, remote: socket.remoteAddress }));
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'ZEWAY MT100 Live Server',
    ok: true,
    httpPort: HTTP_PORT,
    tcpPort: TCP_PORT,
    devicesSeen: devices.size,
    relayCommandsEnabled: ENABLE_RELAY
  });
});

app.get('/api/server-info', (req, res) => {
  res.json({
    ok: true,
    httpDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    tcpProxyDomain: process.env.RAILWAY_TCP_PROXY_DOMAIN || null,
    tcpProxyPort: process.env.RAILWAY_TCP_PROXY_PORT ? Number(process.env.RAILWAY_TCP_PROXY_PORT) : null,
    tcpApplicationPort: process.env.RAILWAY_TCP_APPLICATION_PORT ? Number(process.env.RAILWAY_TCP_APPLICATION_PORT) : TCP_PORT
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    tcpPort: TCP_PORT,
    devicesSeen: devices.size,
    tcpProxyDomain: process.env.RAILWAY_TCP_PROXY_DOMAIN || null,
    tcpProxyPort: process.env.RAILWAY_TCP_PROXY_PORT || null,
    tcpApplicationPort: process.env.RAILWAY_TCP_APPLICATION_PORT || null
  });
});

app.get('/api/server-endpoint', (req, res) => {
  res.json({
    httpDomain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
    tcpProxyDomain: process.env.RAILWAY_TCP_PROXY_DOMAIN || null,
    tcpProxyPort: process.env.RAILWAY_TCP_PROXY_PORT || null,
    tcpApplicationPort: process.env.RAILWAY_TCP_APPLICATION_PORT || String(TCP_PORT)
  });
});

app.get('/api/devices', (req, res) => {
  res.json([...devices.values()].map(publicDevice));
});

app.get('/api/devices/:id/live', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'device_not_seen', deviceId: req.params.id });
  res.json(publicDevice(d));
});

app.get('/api/devices/:id/packets', (req, res) => {
  const d = getDevice(req.params.id);
  if (!d) return res.status(404).json({ error: 'device_not_seen', deviceId: req.params.id });
  res.json({ deviceId: d.deviceId, packets: d.packets || [] });
});

app.get('/api/devices/:id/trips', (req, res) => {
  const key = resolveDeviceKey(req.params.id);
  res.json({
    deviceId: key,
    activeTrip: activeTrips.get(key) || null,
    trips: tripHistory.get(key) || []
  });
});

app.post('/api/devices/:id/commands', (req, res) => {
  const requested = req.params.id;
  const key = resolveDeviceKey(requested);
  const socket = socketsByDevice.get(key);
  if (!socket || socket.destroyed) {
    return res.status(409).json({ error: 'device_not_connected', deviceId: requested });
  }

  const name = String(req.body?.command || '').toLowerCase();
  let command = null;

  if (name === 'locate') command = '*HQ2001BE#';
  else if (name === 'restart') command = '*HQ2011BA0#';
  else if (name === 'set_30s_interval') command = '*HQ2011BI001EFFFF#';
  else if (name === 'lock' || name === 'unlock') {
    if (!ENABLE_RELAY) {
      return res.status(403).json({
        error: 'relay_disabled',
        message: 'Relay control is disabled until parked-vehicle bench verification is completed.'
      });
    }
    command = name === 'lock' ? '*HQ2011BB1#' : '*HQ2011BB0#';
  } else {
    return res.status(400).json({ error: 'unsupported_command', supported: ['locate', 'restart', 'set_30s_interval', 'lock', 'unlock'] });
  }

  try {
    socket.write(command);
    console.log(JSON.stringify({ type: 'tracker_command', deviceId: key, name, command }));
    res.json({ ok: true, deviceId: key, command: name, sentAt: nowIso() });
  } catch (err) {
    res.status(500).json({ error: 'send_failed', message: err.message });
  }
});

app.get('/api/debug/aliases', (req, res) => {
  res.json(Object.fromEntries(aliases.entries()));
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ type: 'http_listen', port: HTTP_PORT }));
});

tcpServer.listen(TCP_PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ type: 'tcp_listen', port: TCP_PORT }));
  console.log(JSON.stringify({
    type: 'tcp_proxy_endpoint',
    domain: process.env.RAILWAY_TCP_PROXY_DOMAIN || null,
    externalPort: process.env.RAILWAY_TCP_PROXY_PORT || null,
    applicationPort: process.env.RAILWAY_TCP_APPLICATION_PORT || String(TCP_PORT)
  }));
});

process.on('SIGTERM', () => {
  try { tcpServer.close(); } catch {}
  try { httpServer.close(); } catch {}
  setTimeout(() => process.exit(0), 1000).unref();
});
