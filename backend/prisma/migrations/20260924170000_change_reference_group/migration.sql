-- Documents uploaded while recording a plan change get their own group.
--
-- Not one of the four classified groups: those cap at MAX_FILES_PER_GROUP (2), so ten documents
-- attached to a change would permanently exhaust whichever tile they landed in. Not DESCRIPTION
-- either, since an upload there supersedes the current description by definition.
--
-- ALTER TYPE ... ADD VALUE appends to the end of the enum and the new value must not be used in the
-- same transaction — nothing here does.
ALTER TYPE "ReferenceGroup" ADD VALUE 'CHANGE';
