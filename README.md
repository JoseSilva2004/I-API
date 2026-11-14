# 🚀 I-API — Gateway Omnicanal de Mensajería (WhatsApp & Telegram)

API REST Multi-Proyecto (*Multi-Tenant*) construida con **Node.js, TypeScript, Fastify, Prisma y PostgreSQL** para el envío automatizado, asíncrono y seguro de mensajes de texto, documentos PDF e imágenes a través de **WhatsApp** (`@whiskeysockets/baileys`) y **Telegram** (`grammY`).

---

## ✨ Características Principales

- **Persistencia Criptográfica en PostgreSQL (`session_creds`)**: Reemplaza los archivos JSON sueltos por almacenamiento transaccional en `JSONB`, evitando la corrupción de llaves *Signal* y cierres de sesión inesperados.
- **Cola Inteligente con `FOR UPDATE SKIP LOCKED`**: No requiere Redis ni RabbitMQ. Soporta niveles de prioridad (`HIGH` | `NORMAL`).
- **Algoritmo Anti-Baneo con Enfriamiento Adaptativo**:
  - **Modo Reposo (> 2 min sin actividad)**: El primer mensaje sale en **3 a 4.5 segundos** simulando el estado *"Escribiendo..."* (`composing`).
  - **Modo Ráfaga (Cola activa)**: Aplica automáticamente un *Jitter* aleatorio de **20 a 45 segundos** entre envíos consecutivos para evitar patrones matemáticos detectables por Meta.
- **Privacidad y Ahorro de Disco (Auto-Purga 24h)**: Un *worker* automático limpia el contenido sensible (`payload = NULL`) 24 horas después de enviado el mensaje, conservando únicamente los metadatos de auditoría y conteo.
- **Multi-Proyecto / Multi-Cliente**: Una sola instancia de la API y una sola base de datos gestionan múltiples sistemas externos (PHP, .NET, Python, etc.) mediante su propio `x-api-key`.

---

## 🛠️ Requisitos e Instalación Rápida (Docker)

1. Clonar el repositorio y crear el archivo `.env`:
   ```bash
   cp .env.example .env
   ```

2. Levantar los contenedores (API + PostgreSQL 16 Alpine):
   ```bash
   docker compose up -d --build
   ```

3. Ver los logs para obtener la `API Key` inicial generada automáticamente:
   ```bash
   docker logs -f iapi-server
   ```
   *(Por defecto se crea el proyecto inicial con la llave: `iapi_default_key_2026`).*

---

## 📱 Vinculación de WhatsApp (QR o Código de 8 Dígitos)

### Opción A: Desde el Navegador (Vista Rápida)
Abre en tu navegador:
- **Por Código QR**:  
  `http://localhost:3100/api/v1/instances/qr?apiKey=iapi_default_key_2026`
- **Por Código de 8 Dígitos (Sin cámara)**:  
  `http://localhost:3100/api/v1/instances/qr?apiKey=iapi_default_key_2026&phone=584121234567`

### Opción B: Por API (`POST /api/v1/instances/connect`)
```bash
curl -X POST http://localhost:3100/api/v1/instances/connect \
  -H "Content-Type: application/json" \
  -H "x-api-key: iapi_default_key_2026" \
  -d '{"phoneNumber": "584121234567"}'
```

---

## 📡 Documentación de Endpoints

### 1. Enviar Mensaje de Texto (`POST /api/v1/messages/send`)
Responde `HTTP 202 Accepted` en milisegundos y encola el mensaje.

```json
{
  "channel": "WHATSAPP",
  "priority": "NORMAL",
  "recipient": "584121234567",
  "type": "TEXT",
  "payload": {
    "text": "Hola, su presupuesto ha sido confirmado exitosamente."
  }
}
```

### 2. Enviar Documento PDF en Base64 o URL (`POST /api/v1/messages/send`)
```json
{
  "channel": "WHATSAPP",
  "priority": "HIGH",
  "recipient": "584121234567",
  "type": "DOCUMENT",
  "payload": {
    "fileName": "Reporte_Laboratorio.pdf",
    "mimeType": "application/pdf",
    "caption": "Adjuntamos sus resultados médicos.",
    "mediaBase64": "JVBERi0xLjQKJeLjz9MK..."
  }
}
```

### 3. Consultar Estado de un Mensaje (`GET /api/v1/messages/:id`)
Verifica si el mensaje está en `PENDING`, `PROCESSING`, `SENT` o `FAILED`.

### 4. Consultar Estado de Conexión (`GET /api/v1/instances/status`)
Devuelve si el socket de WhatsApp y el Bot de Telegram están `CONNECTED` o `DISCONNECTED`.

### 5. Crear un Nuevo Proyecto / Cliente (`POST /api/v1/tenants`)
Requiere el header administrativo `x-admin-key`:
```bash
curl -X POST http://localhost:3100/api/v1/tenants \
  -H "Content-Type: application/json" \
  -H "x-admin-key: iapi_master_secret_2026" \
  -d '{"name": "Sistema Clínica Analab"}'
```

---

## 🔌 Ejemplo de Consumo desde PHP (KumbiaPHP / cURL)

```php
function enviarMensajeIAPI(string $telefono, string $texto, string $prioridad = 'NORMAL'): array {
    $ch = curl_init('http://localhost:3100/api/v1/messages/send');
    $payload = json_encode([
        'channel'   => 'WHATSAPP',
        'priority'  => $prioridad,
        'recipient' => $telefono,
        'type'      => 'TEXT',
        'payload'   => ['text' => $texto]
    ]);

    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'x-api-key: iapi_default_key_2026'
        ]
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return ['status' => $httpCode, 'body' => json_decode($response, true)];
}
```

---

## 🗂️ Estructura del Proyecto

```text
I-API/
├── docker-compose.yml          # Orquestación de API + PostgreSQL 16 Alpine
├── Dockerfile                  # Contenedor Node.js 20 Alpine
├── prisma/
│   └── schema.prisma           # Tablas: tenants, session_creds y message_queue
└── src/
    ├── server.ts               # Entrada Fastify y arranque de Workers
    ├── config/                 # Variables de entorno y cliente Prisma
    ├── middlewares/            # Autenticación por x-api-key y x-admin-key
    ├── modules/                # Rutas REST (instances y messages)
    ├── providers/              # Adaptadores desacoplados (WhatsApp Baileys / Telegram)
    └── workers/                # Cola SKIP LOCKED anti-baneo y limpieza 24h
```

