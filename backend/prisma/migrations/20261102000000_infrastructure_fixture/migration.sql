CREATE TABLE "infrastructure_fixture" (
    "key" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    CONSTRAINT "infrastructure_fixture_pkey" PRIMARY KEY ("key")
);

-- The migration role owns this table. Runtime has no write or schema privileges.
GRANT SELECT ON TABLE "infrastructure_fixture" TO it_runtime;
