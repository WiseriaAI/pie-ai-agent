# Localization QA Checklist

Run this checklist for each locale before launch.

## Locale

- Locale id:
- Reviewer:
- Review date:

## Activation Path

- The user understands how to open Settings.
- The user understands provider/API key setup.
- The user understands managed account setup where shown.
- The user understands how to send the first task.
- Error/CTA copy explains the next action.

## Privacy Claims

- BYOK explanation matches the glossary.
- No telemetry claim matches the glossary.
- No backend/no proxy claim matches the glossary.
- API key local encryption claim matches the glossary.
- Copy does not imply the selected model provider receives no data.

## Visual Review

- Buttons do not overflow.
- Dropdowns do not clip.
- Screenshot captions fit.
- Japanese line breaks look natural.
- Spanish and Portuguese long strings wrap cleanly.

## Store Review

- Name fits Chrome Web Store limits.
- Short description fits Chrome Web Store limits.
- Long description has setup steps.
- Provider list is current.
- Support/feedback link is present.

## Decision

- Launch approved:
- Required changes:

## Verification Commands

- `pnpm typecheck`: 2026-06-13 1d982da5 PASS
- `pnpm test`: 2026-06-13 1d982da5 PASS
- `pnpm build`: 2026-06-13 1d982da5 PASS
- `pnpm check:i18n`: 2026-06-13 1d982da5 PASS

## Launch Gate

Launch is blocked until each locale has reviewer approval for:

- Extension UI activation path.
- Chrome Web Store copy.
- Landing page route.
- README setup guide.
- Screenshot captions.
