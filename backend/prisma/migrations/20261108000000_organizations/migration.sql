-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_owner" (
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "organization_owner_pkey" PRIMARY KEY ("organizationId","userId")
);

-- CreateIndex
CREATE INDEX "organization_owner_userId_idx" ON "organization_owner"("userId");

-- AddForeignKey
ALTER TABLE "organization_owner" ADD CONSTRAINT "organization_owner_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_owner" ADD CONSTRAINT "organization_owner_userId_fkey" FOREIGN KEY ("userId") REFERENCES "application_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Limited runtime CRUD for application organization tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "organization", "organization_owner" TO it_runtime;
