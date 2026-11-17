-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('WHATSAPP', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "MessagePriority" AS ENUM ('HIGH', 'NORMAL');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'DOCUMENT', 'IMAGE');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "api_key" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "telegram_bot_token" TEXT,
    "last_whatsapp_sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_creds" (
    "tenant_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL DEFAULT 'WHATSAPP',
    "key_id" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_creds_pkey" PRIMARY KEY ("tenant_id","channel","key_id")
);

-- CreateTable
CREATE TABLE "message_queue" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "priority" "MessagePriority" NOT NULL DEFAULT 'NORMAL',
    "recipient" TEXT NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "payload" JSONB,
    "status" "MessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_reason" TEXT,
    "locked_at" TIMESTAMP(3),
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_api_key_key" ON "tenants"("api_key");

-- CreateIndex
CREATE INDEX "message_queue_status_priority_scheduled_at_created_at_idx" ON "message_queue"("status", "priority", "scheduled_at", "created_at");

-- CreateIndex
CREATE INDEX "message_queue_status_sent_at_idx" ON "message_queue"("status", "sent_at");

-- CreateIndex
CREATE INDEX "message_queue_status_locked_at_idx" ON "message_queue"("status", "locked_at");

-- AddForeignKey
ALTER TABLE "session_creds" ADD CONSTRAINT "session_creds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

