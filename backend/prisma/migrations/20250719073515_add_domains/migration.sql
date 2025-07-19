-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'PENDING', 'ERROR');

-- CreateEnum
CREATE TYPE "SSLStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'ERROR');

-- CreateTable
CREATE TABLE "domains" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DomainStatus" NOT NULL DEFAULT 'ACTIVE',
    "dnsRecords" JSONB,
    "sslStatus" "SSLStatus" NOT NULL DEFAULT 'PENDING',
    "sslExpiry" TIMESTAMP(3),
    "redirectTo" TEXT,
    "customConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "domains_name_key" ON "domains"("name");

-- AddForeignKey
ALTER TABLE "domains" ADD CONSTRAINT "domains_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
