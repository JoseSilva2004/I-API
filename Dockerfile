FROM node:20-alpine

# Dependencias necesarias para Prisma y criptografía en Alpine
RUN apk add --no-cache openssl git

WORKDIR /app

COPY package.json ./
COPY prisma ./prisma/

RUN npm install

COPY tsconfig.json ./
COPY src ./src/

RUN npx prisma generate && npm run build

EXPOSE 3100

# Ejecución compilada con recolector de basura optimizado (~75MB RAM en lugar de 145MB)
CMD ["sh", "-c", "npx prisma db push --skip-generate && node --max-old-space-size=160 dist/server.js"]

