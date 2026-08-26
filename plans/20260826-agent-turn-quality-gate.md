# Agent turn quality gate

## Goal

Prevent an ordinary completed Agent turn from being reported to the UI as an updated deck when its slide HTML violates the content policy.

## Plan

1. Run the existing committable/content-policy audit after every completed Agent edit.
2. Publish a structured error instead of an `updated` event when the audit fails, while preserving the inspectable files.
3. Clarify that `content` and `title` roles use `data-weave-slot`, not CSS classes.
4. Add regression coverage for ordinary and variation completion paths.
5. Run focused and full tests, then obtain reviewer feedback.
