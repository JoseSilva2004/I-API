FROM node:20-alpine

# Dependencias necesarias para Prisma y criptografía en Alpine
RUN apk add --no-cache openssl git

WORKDIR /app

COPY package.json ./
COPY prisma ./prisma/

RUN npm install

COPY tsconfig.json ./
COPY src ./src/

RUN npx prisma generate

EXPOSE 3100

# Al iniciar aplica el esquema en Postgres y arranca el servidor
CMD ["sh", "-c", "npx prisma db push && npm run dev"]

