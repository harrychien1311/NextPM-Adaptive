-- Documents the Planning Assessment adds beyond the standard catalog. See the model comment.
ALTER TABLE "document_definitions" ADD COLUMN "extended" BOOLEAN NOT NULL DEFAULT false;
