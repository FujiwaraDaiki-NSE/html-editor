# Code view scroll fix

## Goal

Allow the Code tab to show and scroll through the complete slide HTML in both directions.

## Plan

1. Make the code editor a vertical flex container.
2. Keep the breadcrumb at its fixed height and make the code area scrollable.
3. Preserve complete line backgrounds for horizontally scrolling long lines.
4. Run the build and commit only the CSS and plan changes.
