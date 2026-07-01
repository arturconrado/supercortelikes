-- AlterTable
ALTER TABLE "videos" ADD COLUMN     "audioCodec" TEXT,
ADD COLUMN     "durationMs" BIGINT,
ADD COLUMN     "frameRate" DOUBLE PRECISION,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "videoCodec" TEXT,
ADD COLUMN     "width" INTEGER;
