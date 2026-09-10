-- CreateTable
CREATE TABLE "heartbeats" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "responseMs" INTEGER,
    "httpStatus" INTEGER,
    "error" TEXT,

    CONSTRAINT "heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "heartbeats_targetType_targetId_at_idx" ON "heartbeats"("targetType", "targetId", "at");
