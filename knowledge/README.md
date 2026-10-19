# Knowledge base

`base.md` holds confirmed facts about Junaid — the bot answers from these.
Add one `.md` file per topic as needed (pricing, FAQ, policies...).

How it works:
- At startup the bot chunks and indexes every `.md` file here (except this
  README) with local BM25 search — no embeddings, no extra cost.
- When a customer asks something, the most relevant chunks are pasted into
  the prompt as "Business knowledge".
- Re-ingesting is automatic on every restart: each file replaces its own
  previous chunks, so updated files never leave stale data behind.
- `*.example.md` files and files starting with `<!-- PLACEHOLDER -->` are
  skipped (templates never leak into answers).
- `<!-- TODO: ... -->` comments *inside* a real file are kept out of answers
  by the system prompt — they're the owner's private reminders.

Rules for writing knowledge files:
- One fact per short paragraph works best for retrieval.
- Write only what is TRUE. The bot quotes this verbatim-ish to customers;
  anything uncertain stays a TODO comment, never a stated fact.
