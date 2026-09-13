-- Records whether a recommendation came from the model or from the deterministic mock fallback.
ALTER TABLE "ai_approach_suggestions" ADD COLUMN "aiProvider" TEXT NOT NULL DEFAULT 'mock';

-- Only the project/service/product name and its objective stay required; every other input is a
-- signal the PM may leave blank or let document extraction fill in.
UPDATE "input_field_definitions"
SET "required" = false
WHERE "key" NOT IN ('projectName', 'businessObjective', 'serviceName', 'serviceObjective', 'productName', 'productVision');
