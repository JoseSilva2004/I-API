import dns from 'dns/promises';
import net from 'net';

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_FETCH_TIMEOUT_MS = 30_000;

const BLOCKED_HOSTNAMES = new Set(['localhost', 'iapi-db', 'iapi-postgres', 'iapi-server']);

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

// Direcciones privadas, locales, reservadas o de multicast (IPv4 e IPv6, incluidas las IPv4 mapeadas)
export function isPrivateOrReservedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (!net.isIPv6(ip)) return false;

  const normalized = ip.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  if (normalized.startsWith('::ffff:')) return true;

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

// Valida que mediaUrl sea HTTPS y que el dominio solo resuelva a direcciones públicas (previene SSRF)
export async function validateSafeMediaUrl(rawUrl: string): Promise<{ valid: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'mediaUrl no tiene un formato de URL válido' };
  }

  if (parsed.protocol !== 'https:') {
    return { valid: false, reason: 'mediaUrl solo permite protocolo https://' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { valid: false, reason: 'mediaUrl apunta a un host interno no permitido' };
  }

  if (net.isIP(hostname)) {
    return isPrivateOrReservedIp(hostname)
      ? { valid: false, reason: 'mediaUrl no puede apuntar a direcciones IP privadas o locales' }
      : { valid: true };
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (records.some((rec) => isPrivateOrReservedIp(rec.address))) {
      return { valid: false, reason: 'mediaUrl resuelve a una dirección IP privada o interna bloqueada' };
    }
  } catch {
    return { valid: false, reason: 'No se pudo resolver el dominio de mediaUrl' };
  }

  return { valid: true };
}

// Descarga el archivo en el momento del envío: vuelve a validar la URL, no sigue redirecciones y limita el tamaño
export async function fetchSafeMedia(rawUrl: string): Promise<Buffer> {
  const check = await validateSafeMediaUrl(rawUrl);
  if (!check.valid) {
    throw new Error(`INVALID_MEDIA_URL: ${check.reason}`);
  }

  const response = await fetch(rawUrl, {
    redirect: 'error',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS)
  });
  if (!response.ok) {
    throw new Error(`MEDIA_DOWNLOAD_FAILED: HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_MEDIA_BYTES) {
    throw new Error('INVALID_MEDIA_URL: el archivo supera el tamaño máximo de 25MB');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_MEDIA_BYTES) {
    throw new Error('INVALID_MEDIA_URL: el archivo supera el tamaño máximo de 25MB');
  }
  return buffer;
}
