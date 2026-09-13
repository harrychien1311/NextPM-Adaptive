-- Chat threads. A session belongs to one project AND one user: chats are private to whoever
-- held them, matching how project access already works.
CREATE TABLE "agent_sessions" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL DEFAULT 'New chat',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_sessions_projectId_userId_updatedAt_idx"
    ON "agent_sessions"("projectId", "userId", "updatedAt");

ALTER TABLE "agent_sessions"
    ADD CONSTRAINT "agent_sessions_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_sessions"
    ADD CONSTRAINT "agent_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing messages predate sessions, so the column is nullable rather than backfilled with a
-- guessed owner. They stay readable; new chats all belong to a session.
ALTER TABLE "agent_messages" ADD COLUMN "sessionId" TEXT;

CREATE INDEX "agent_messages_sessionId_createdAt_idx" ON "agent_messages"("sessionId", "createdAt");

ALTER TABLE "agent_messages"
    ADD CONSTRAINT "agent_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "agent_sessions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Give every project that already has chat history one "Earlier conversation" session so nothing
-- disappears from the UI, which now lists messages by session.
INSERT INTO "agent_sessions" ("id", "projectId", "userId", "title", "createdAt", "updatedAt")
SELECT gen_random_uuid(), m."projectId", NULL, 'Earlier conversation', MIN(m."createdAt"), MAX(m."createdAt")
FROM "agent_messages" m
WHERE m."sessionId" IS NULL
GROUP BY m."projectId";

UPDATE "agent_messages" m
SET "sessionId" = s."id"
FROM "agent_sessions" s
WHERE m."sessionId" IS NULL
  AND s."projectId" = m."projectId"
  AND s."title" = 'Earlier conversation';
