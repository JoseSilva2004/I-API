// Pruebas de humo contra una instancia en marcha (no necesitan WhatsApp vinculado).
// Variables: IAPI_URL (por defecto http://localhost:3100), IAPI_API_KEY, IAPI_ADMIN_KEY
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.IAPI_URL || 'http://localhost:3100';
const API_KEY = process.env.IAPI_API_KEY;
const ADMIN_KEY = process.env.IAPI_ADMIN_KEY;

if (!API_KEY || !ADMIN_KEY) {
  throw new Error('Defina IAPI_API_KEY e IAPI_ADMIN_KEY para ejecutar las pruebas de humo');
}

async function call(method, path, { key, admin, body, redirect = 'follow' } = {}) {
  const headers = {};
  if (key) headers['x-api-key'] = key;
  if (admin) headers['x-admin-key'] = admin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* respuesta HTML */ }
  return { status: res.status, json, text, headers: res.headers };
}

const send = (body, key = API_KEY) => call('POST', '/api/v1/messages/send', { key, body });

test('health responde 200', async () => {
  assert.equal((await call('GET', '/health')).status, 200);
});

test('autenticación por x-api-key', async () => {
  assert.equal((await call('GET', '/api/v1/instances/status')).status, 401);
  assert.equal((await call('GET', '/api/v1/instances/status', { key: 'iapi_invalida' })).status, 401);
  assert.equal((await call('GET', '/api/v1/instances/status', { key: API_KEY })).status, 200);
});

test('crear proyecto exige x-admin-key y no devuelve secretos guardados', async () => {
  assert.equal((await call('POST', '/api/v1/tenants', { admin: 'x'.repeat(40), body: { name: 'X' } })).status, 401);
  const res = await call('POST', '/api/v1/tenants', { admin: ADMIN_KEY, body: { name: 'Smoke', telegramBotToken: '1:SECRETO' } });
  assert.equal(res.status, 200);
  assert.match(res.json.data.apiKey, /^iapi_[0-9a-f]{32}$/);
  assert.ok(!res.text.includes('1:SECRETO'));
});

test('validación del cuerpo de /messages/send', async () => {
  const r = '584141234567';
  assert.equal((await send({ recipient: r, type: 'VIDEO', payload: { text: 'x' } })).status, 400);
  assert.equal((await send({ recipient: r, channel: 'SMS', payload: { text: 'x' } })).status, 400);
  assert.equal((await send({ recipient: r, type: 'TEXT', payload: {} })).status, 400);
  assert.equal((await send({ recipient: r, type: 'DOCUMENT', payload: {} })).status, 400);
  assert.equal((await send({ recipient: r, type: 'DOCUMENT', payload: { mediaUrl: 'http://example.com/a.pdf' } })).status, 400);
  assert.equal((await send({ recipient: r, type: 'DOCUMENT', payload: { mediaUrl: 'https://127.0.0.1/a.pdf' } })).status, 400);
  assert.equal((await send({ recipient: r })).status, 400);
});

test('encolar, consultar y aislamiento entre proyectos', async () => {
  const queued = await send({ recipient: '584141234567', type: 'TEXT', payload: { text: 'Prueba de humo' } });
  assert.equal(queued.status, 202);
  const id = queued.json.data.messageId;

  const own = await call('GET', `/api/v1/messages/${id}`, { key: API_KEY });
  assert.equal(own.status, 200);
  assert.ok(['PENDING', 'PROCESSING', 'SENT', 'FAILED'].includes(own.json.data.status));

  const other = await call('POST', '/api/v1/tenants', { admin: ADMIN_KEY, body: { name: 'Smoke B' } });
  assert.equal((await call('GET', `/api/v1/messages/${id}`, { key: other.json.data.apiKey })).status, 404);
});

test('cleanup exige hoursOld >= 1', async () => {
  assert.equal((await call('POST', '/api/v1/messages/cleanup', { key: API_KEY, body: { hoursOld: 0 } })).status, 400);
  assert.equal((await call('POST', '/api/v1/messages/cleanup', { key: API_KEY, body: { hoursOld: -5 } })).status, 400);
  assert.equal((await call('POST', '/api/v1/messages/cleanup', { key: API_KEY, body: { hoursOld: 24 } })).status, 200);
});

test('la página del QR cambia la apiKey de la URL por un token temporal', async () => {
  const first = await call('GET', `/api/v1/instances/qr?apiKey=${API_KEY}`, { redirect: 'manual' });
  assert.equal(first.status, 302);
  const location = first.headers.get('location');
  assert.ok(location.includes('token=') && !location.includes(API_KEY));
  assert.equal((await call('GET', '/api/v1/instances/qr?token=a.1.b')).status, 401);
});
