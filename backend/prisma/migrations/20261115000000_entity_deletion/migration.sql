-- Deleting an entity removes only its dependent relationships.
ALTER TABLE "provider_identity" DROP CONSTRAINT "provider_identity_userId_fkey",
    ADD CONSTRAINT "provider_identity_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "application_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_owner" DROP CONSTRAINT "organization_owner_userId_fkey",
    ADD CONSTRAINT "organization_owner_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "application_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "organization_owner" DROP CONSTRAINT "organization_owner_organizationId_fkey",
    ADD CONSTRAINT "organization_owner_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tour" DROP CONSTRAINT "tour_organizationId_fkey",
    ADD CONSTRAINT "tour_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tour_access" DROP CONSTRAINT "tour_access_tourId_fkey",
    ADD CONSTRAINT "tour_access_tourId_fkey"
    FOREIGN KEY ("tourId")
    REFERENCES "tour"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tour_access" DROP CONSTRAINT "tour_access_userId_fkey",
    ADD CONSTRAINT "tour_access_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "application_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT DELETE ON TABLE "organization", "tour" TO it_runtime;
