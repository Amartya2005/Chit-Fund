-- P8 / M6: online bidding (additive). AuctionBid (existing, never written before) gains engine
-- session columns; auctionId becomes nullable (decision D-30: extend the existing table).

-- AlterTable
ALTER TABLE "AuctionBid" ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "memberId" TEXT,
ADD COLUMN     "placedByUserId" TEXT,
ADD COLUMN     "rejectReason" TEXT,
ADD COLUMN     "sequenceNo" INTEGER,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "source" TEXT,
ADD COLUMN     "status" TEXT,
ALTER COLUMN "auctionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AuctionSessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuctionSessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuctionSessionEvent_sessionId_seq_key" ON "AuctionSessionEvent"("sessionId", "seq");

-- CreateIndex
CREATE INDEX "AuctionBid_sessionId_status_idx" ON "AuctionBid"("sessionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionBid_sessionId_sequenceNo_key" ON "AuctionBid"("sessionId", "sequenceNo");

-- CreateIndex
CREATE UNIQUE INDEX "AuctionBid_sessionId_memberId_clientRequestId_key" ON "AuctionBid"("sessionId", "memberId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "AuctionBid" ADD CONSTRAINT "AuctionBid_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuctionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuctionSessionEvent" ADD CONSTRAINT "AuctionSessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuctionSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Engine bids must carry the session data; accepted bids carry their sequence number.
ALTER TABLE "AuctionBid" ADD CONSTRAINT "AuctionBid_engine_check" CHECK (
  "sessionId" IS NULL
  OR ("companyId" IS NOT NULL AND "memberId" IS NOT NULL AND "clientRequestId" IS NOT NULL
      AND "status" IN ('ACCEPTED', 'REJECTED') AND "source" IN ('ONLINE', 'PROXY', 'FLOOR')
      AND (("status" = 'ACCEPTED' AND "sequenceNo" IS NOT NULL) OR ("status" = 'REJECTED' AND "sequenceNo" IS NULL AND "rejectReason" IS NOT NULL))
      AND "bidDiscount" >= 0)
);
ALTER TABLE "AuctionSessionEvent" ADD CONSTRAINT "AuctionSessionEvent_seq_check" CHECK ("seq" >= 1);

-- Bids and session events are an audit trail: never changed or deleted.
CREATE OR REPLACE FUNCTION "chitkart_engine_bid_guard"() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD."sessionId" IS NOT NULL THEN
    RAISE EXCEPTION 'Online bids are immutable' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "AuctionBid_engine_guard" BEFORE UPDATE OR DELETE ON "AuctionBid"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_engine_bid_guard"();
CREATE TRIGGER "AuctionSessionEvent_guard" BEFORE UPDATE OR DELETE ON "AuctionSessionEvent"
  FOR EACH ROW EXECUTE FUNCTION "chitkart_append_only_guard"();
ALTER TABLE "AuctionSessionEvent" ENABLE ROW LEVEL SECURITY;
