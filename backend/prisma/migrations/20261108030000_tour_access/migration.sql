CREATE TYPE "TourRole" AS ENUM ('ADMIN');
CREATE TABLE "tour_access" (
  "tourId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "TourRole" NOT NULL,
  CONSTRAINT "tour_access_pkey" PRIMARY KEY ("tourId", "userId"),
  CONSTRAINT "tour_access_tourId_fkey" FOREIGN KEY ("tourId") REFERENCES "tour"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "tour_access_userId_fkey" FOREIGN KEY ("userId") REFERENCES "application_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "tour_access_userId_idx" ON "tour_access"("userId");
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tour_access" TO it_runtime;
