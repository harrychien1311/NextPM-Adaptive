-- Readable uploads are ready for the next analysis as soon as their text is extracted. Reference-group
-- uploads were stored as UPLOADED with a message pointing at the retired "Verify input" button, and
-- showed amber; description uploads said "the next AI recommendation". Both now read the same.
UPDATE "reference_files"
SET "status" = 'VERIFIED', "message" = 'Text extracted — ready for the next AI analysis'
WHERE "message" IN (
  'Text extracted — press Verify input to read it into the form',
  'Text extracted — ready for the next AI recommendation'
);
