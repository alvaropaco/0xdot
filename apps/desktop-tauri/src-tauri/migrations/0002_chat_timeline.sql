-- M2: the transcript carries tool activity and approval requests besides chat.
-- Additive columns only: v0.3.7 rows keep the default kind 'chat', and history
-- replay feeds the model only 'chat' rows so tool/approval lines never look
-- like user or assistant turns.
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE messages ADD COLUMN payload TEXT NOT NULL DEFAULT '';
