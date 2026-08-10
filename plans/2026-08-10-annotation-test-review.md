# Annotation architecture test review fix

1. Relax the reference-button architecture assertions to verify gating, label intent, and shared helper usage without matching whole JSX lines or exact arguments.
2. Remove the no-op annotation wording replacement while retaining all behavioral and documentation assertions.
3. Run `npm test`, review the diff, and commit the focused fix once.
