# Improvements

## Prompt construction for follow-ups

- **Current behavior:** `buildApiMessages()` in `chrome-extension/content.js` builds the custom context prompt using `thread.messages[0]` (the first user question), then appends the rest of the thread history.
- **Issue:** For follow-up turns, the special "Question:" block references the first question, while the latest user question appears later in history. This works, but the framing is less clear and can dilute intent.
- **Recommended improvement:** Build the context block independently from any specific question, then append full conversation history in chronological order so the last user message is naturally the active question being answered.
- **Why this is better:** Cleaner prompt semantics, better multi-turn clarity, and fewer chances the model over-weights the original question during deep follow-ups.

### Suggested structure

1. `system`: assistant behavior + formatting rules.
2. `user` (context only): surrounding context + selected passage.
3. all prior turns in order (`thread.messages`).
4. last turn remains the newest user question.

