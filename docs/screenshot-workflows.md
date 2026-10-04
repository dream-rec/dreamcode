# Screenshot Workflows

## Default shortcuts

| Shortcut | Action |
| --- | --- |
| Alt+Enter | Capture a new question, replacing the previous conversation after capture succeeds |
| Alt+Shift+Enter | Append another screenshot to the current input or follow up on a completed answer |
| Alt+. | Stop generation |

Screenshot batches are sent automatically after **two seconds without another screenshot**. Each capture resets the inactivity timer. There is no screenshot confirmation dialog, mode selector, manual send button, or discard button.

All bindings remain customizable. Shortcut configuration version 9 removes the former feedback/send actions while preserving other custom bindings, including both familiar screenshot shortcuts.

## Long questions

Start with Alt+Enter, then use Alt+Shift+Enter for the remaining pages. Starting with append on an empty conversation also works. Images collected in one burst become one user message containing every image, not just the thumbnail preview.

If no complete answer existed when an append batch started, that batch remains original-question input. This also applies when the first answer finishes while capturing: after it finishes, the next request solves the full original image set again without inventing an assistant message.

## Following up on an answer

After an answer completes, use the same append shortcut for error/result screenshots. The batch includes all original images, every actual completed assistant reply, all earlier feedback turns, and the new images in chronological order. The five-thumbnail preview limit does not truncate model context.

If another answer is streaming when the two-second timer expires, the next batch waits for it to finish. No concurrent model requests are started and no new images are discarded. The batch's role is fixed when collection starts, not reinterpreted when the timer expires.

## Failures and new questions

- Failed or stopped requests retain their input. Partial output is not committed as a completed assistant answer.
- Failures show a non-blocking message and do not automatically retry. Add another screenshot to continue; retained failed input and new images are sent together in one attempt, not as a retry followed by a second request.
- A failed text follow-up is also retained when adding screenshot context.
- Alt+Enter deliberately starts fresh without any confirmation. A failed new capture leaves the existing conversation and inputs intact.
- Stale stream events cannot modify a replacement question. An aborted stream must close before a replacement model request starts.
- Navigating back restores the main-owned snapshot. Restarting the app resets this in-memory conversation.

## Settings and application audio

Settings drafts are kept for the current page visit. Main-process updates synchronize saved configuration without echoing it back or resetting an open draft. Theme, opacity, and font size remain local renderer preferences. Explicit saves wait for the main process and report failures.

After changing the audio application, click Save and wait for success. Saving retires the old capture without sending a question or deleting transcript lines. Press the listening shortcut to start the new target. Recording tests and formal listening cannot take over each other's capture session.

## Verification

`npm test` covers fake-timer screenshot batching, full outgoing message history, capture ownership, and the actual settings store/App effects/settings form/main broadcast path using an isolated hook host and mocked preload. These tests do not record audio, capture the screen, or contact providers. `npm run typecheck` and `npm run build` check compilation and bundling. Actual Electron UI and OS/device behavior require separate smoke/manual verification; hook-host tests alone do not establish real UI correctness.
