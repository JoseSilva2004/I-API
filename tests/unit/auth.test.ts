import { before, test } from 'node:test';
import assert from 'node:assert/strict';

type AuthModule = typeof import('../../src/middlewares/auth.middleware.js');
let hashApiKey: AuthModule['hashApiKey'];
let createQrViewToken: AuthModule['createQrViewToken'];
let verifyQrViewToken: AuthModule['verifyQrViewToken'];

// env.ts exige ADMIN_MASTER_KEY al importarse: se define antes de cargar el módulo
before(async () => {
  process.env.ADMIN_MASTER_KEY ??= 'clave_de_pruebas_unitarias_de_mas_de_32_caracteres';
  ({ hashApiKey, createQrViewToken, verifyQrViewToken } = await import('../../src/middlewares/auth.middleware.js'));
});

test('hashApiKey es determinista y no contiene la llave', () => {
  const h = hashApiKey('iapi_abc');
  assert.equal(h, hashApiKey('iapi_abc'));
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(h, hashApiKey('iapi_abd'));
});

test('el token del QR es válido para su proyecto y se rechaza si se altera', () => {
  const token = createQrViewToken('tenant-1');
  assert.equal(verifyQrViewToken(token), 'tenant-1');

  const [id, exp, sig] = token.split('.');
  assert.equal(verifyQrViewToken(`tenant-2.${exp}.${sig}`), null);
  assert.equal(verifyQrViewToken(`${id}.${Number(exp) + 1000}.${sig}`), null);
  const otherLast = sig.endsWith('0') ? '1' : '0';
  assert.equal(verifyQrViewToken(`${id}.${exp}.${sig.slice(0, -1)}${otherLast}`), null);
  assert.equal(verifyQrViewToken('basura'), null);
});

test('el token del QR vencido se rechaza', () => {
  const realNow = Date.now;
  const token = createQrViewToken('tenant-1');
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    assert.equal(verifyQrViewToken(token), null);
  } finally {
    Date.now = realNow;
  }
});
