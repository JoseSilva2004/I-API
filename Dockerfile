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

# Ejecución compilada con margen de memoria seguro para PDFs Base64 de hasta 25MB
CMD ["sh", "-c", "npx prisma db push --skip-generate && node --max-old-space-size=384 dist/server.js"]
