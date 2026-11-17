const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

// Con humanize activo resuelve Spintax {Hola|Buen día} y añade una referencia corta anti-hash.
// Sin humanize el texto se envía exactamente como llegó.
export function formatMessageContent(text?: string, humanize = false, messageId?: string): string {
  if (!text) return '';
  if (!humanize) return text;

  const spun = text.replace(/\{([^{}|]+\|[^{}]+)\}/g, (_, options: string) => {
    const parts = options.split('|');
    return parts[randomInt(0, parts.length - 1)];
  });

  const shortRef = (messageId || Math.random().toString(36).substring(2, 6)).slice(0, 4).toUpperCase();
  return `${spun}\n\n_Ref: #${shortRef}_`;
}

// Oculta credenciales que puedan viajar en la URL (apiKey, token) antes de escribirla en los logs
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:apiKey|token)=)[^&#]*/gi, '$1[REDACTED]');
}
