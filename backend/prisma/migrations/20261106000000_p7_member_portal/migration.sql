-- P7: member portal switch (off for every company; decision D-02 is taken per company by the super admin).
-- Member logins are User rows with role MEMBER linked through Subscriber.userId (existing column).

-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "memberPortalEnabled" BOOLEAN NOT NULL DEFAULT false;

