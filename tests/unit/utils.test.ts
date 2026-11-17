import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateOrReservedIp, validateSafeMediaUrl } from '../../src/utils/safe-url.js';
import { formatMessageContent, redactUrl } from '../../src/utils/message-format.js';

test('isPrivateOrReservedIp bloquea redes privadas, locales y reservadas', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.10', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:172.16.0.1', '::ffff:7f00:1', 'ff02::1']) {
    assert.equal(isPrivateOrReservedIp(ip), true, ip);
  }
});

test('isPrivateOrReservedIp permite direcciones públicas', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateOrReservedIp(ip), false, ip);
  }
});

test('validateSafeMediaUrl rechaza URLs inseguras sin consultar DNS', async () => {
  for (const url of ['http://example.com/a.pdf', 'https://localhost/a.pdf', 'https://iapi-db/a.pdf',
    'https://10.1.2.3/a.pdf', 'https://[::1]/a.pdf', 'https://equipo.local/a.pdf', 'no-es-url']) {
    assert.equal((await validateSafeMediaUrl(url)).valid, false, url);
  }
  assert.equal((await validateSafeMediaUrl('https://8.8.8.8/a.pdf')).valid, true);
});

test('formatMessageContent sin humanize devuelve el texto intacto', () => {
  const text = 'Hola {paciente}, opciones {a|b}';
  assert.equal(formatMessageContent(text, false), text);
  assert.equal(formatMessageContent(undefined, false), '');
});

test('formatMessageContent con humanize resuelve spintax, respeta llaves sin | y añade referencia', () => {
  const out = formatMessageContent('{Hola|Buen día} {paciente}', true, 'abcd1234');
  assert.match(out, /^(Hola|Buen día) \{paciente\}\n\n_Ref: #ABCD_$/);
});

test('redactUrl oculta apiKey y token de la URL', () => {
  assert.equal(redactUrl('/api/v1/instances/qr?apiKey=iapi_secreta&phone=58414'), '/api/v1/instances/qr?apiKey=[REDACTED]&phone=58414');
  assert.equal(redactUrl('/api/v1/instances/qr?phone=1&token=abc.def.ghi'), '/api/v1/instances/qr?phone=1&token=[REDACTED]');
  assert.equal(redactUrl('/health'), '/health');
});
