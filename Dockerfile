FROM node:20-alpine

# Dependencias necesarias para Prisma y criptografía en Alpine
RUN apk add --no-cache openssl git

WORKDIR /app

COPY package.json package-lock.json ./
COPY prisma ./prisma/

RUN npm ci

COPY tsconfig.json ./
COPY src ./src/

RUN npx prisma generate && npm run build

EXPOSE 3100

# Migraciones versionadas (prisma migrate deploy) y arranque con margen de memoria para PDFs Base64 de hasta 25MB
COPY docker-entrypoint.sh ./
RUN tr -d '\r' < docker-entrypoint.sh > entrypoint.tmp && mv entrypoint.tmp docker-entrypoint.sh && chmod +x docker-entrypoint.sh
CMD ["./docker-entrypoint.sh"]
