-- A fifth upload slot on the Project Input screen: any other project document the PM wants the
-- agent to read. Treated like the classified groups — text extracted on upload, read on Verify.
ALTER TYPE "ReferenceGroup" ADD VALUE 'OTHER' BEFORE 'DESCRIPTION';
