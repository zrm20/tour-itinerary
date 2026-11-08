CREATE TABLE "tour" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    CONSTRAINT "tour_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "tour_organizationId_idx" ON "tour"("organizationId");
ALTER TABLE "tour" ADD CONSTRAINT "tour_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Runtime can create/read/rename tours, with no schema or deletion privileges.
GRANT SELECT, INSERT, UPDATE ON TABLE "tour" TO it_runtime;
