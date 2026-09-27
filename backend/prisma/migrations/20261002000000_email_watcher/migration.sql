-- CreateTable
CREATE TABLE "email_mailboxes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 993,
    "secure" BOOLEAN NOT NULL DEFAULT true,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "lastError" TEXT,
    "uidValidity" TEXT,
    "lastUid" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_mailboxes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_rules" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromContains" TEXT NOT NULL DEFAULT '',
    "subjectContains" TEXT NOT NULL DEFAULT '',
    "bodyContains" TEXT NOT NULL DEFAULT '',
    "onlyVerified" BOOLEAN NOT NULL DEFAULT true,
    "fields" JSONB NOT NULL DEFAULT '[]',
    "webhookUrl" TEXT,
    "webhookSecret" TEXT NOT NULL,
    "waNumberId" TEXT,
    "waTo" TEXT,
    "waTemplate" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_events" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "webhookAt" TIMESTAMP(3),
    "waAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_mailboxes_organizationId_idx" ON "email_mailboxes"("organizationId");

-- CreateIndex
CREATE INDEX "email_rules_mailboxId_idx" ON "email_rules"("mailboxId");

-- CreateIndex
CREATE INDEX "email_events_status_nextAttemptAt_idx" ON "email_events"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "email_events_createdAt_idx" ON "email_events"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_events_ruleId_messageId_key" ON "email_events"("ruleId", "messageId");

-- AddForeignKey
ALTER TABLE "email_mailboxes" ADD CONSTRAINT "email_mailboxes_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_rules" ADD CONSTRAINT "email_rules_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "email_mailboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "email_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

