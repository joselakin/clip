<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

# UI Layout & Visual Quality Rules (Project-Specific)

Use these rules for every new or updated page so layouts stay clean, readable, and not overly centered.

## 1 Content spread (not narrow-center by default)
- Do not default to a single narrow centered column when wide space is available.
- Use the available content canvas (after sidebar/topnav) with responsive horizontal padding.
- Distribute major sections left-right on desktop/tablet to reduce large empty side areas.

## 2 Grid-first layout
- Prefer responsive CSS Grid for page structure and settings panels.
- Mobile first: start single-column, then expand to multi-column at larger breakpoints.
- Recommended pattern for settings/config cards:
  - Mobile: 1 column
  - Desktop: 2 columns for related cards (e.g., A/B paired sections)
- Keep related controls side-by-side when possible instead of stacking everything vertically.

## 3 Compact and clean composition
- Group related controls into clear cards/sections with consistent spacing rhythm.
- Avoid unnecessary vertical length (“too kebawah”); compact pairings are preferred.
- Keep hierarchy obvious: section label → controls → helper text.

## 4 Color and visual restraint
- Prefer monochrome or very limited palette unless user asks otherwise.
- Avoid many accent colors in one screen; keep emphasis minimal and intentional.
- Ensure readable contrast for text, buttons, states, and form controls.

## 5 Interaction and accessibility baseline
- Interactive elements must be clearly identifiable (buttons, links, toggles, active states).
- Do not rely on color alone to communicate state.
- Keep labels close to inputs and feedback messages easy to spot.

## 6 Definition of done for UI layout tasks
- On large screens, content should look intentionally distributed (not cramped in the center).
- On small screens, layout must collapse cleanly without horizontal overflow.
- Spacing, alignment, and card grouping should feel consistent and tidy.

<!-- END:nextjs-agent-rules -->