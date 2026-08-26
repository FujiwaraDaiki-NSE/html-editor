# Template master and layout hierarchy

## Goal

Replace flat slide templates with an explicit hierarchy: a Template owns one Master and multiple Layouts, while each Slide stores only its selected Template/Layout and editable slot content. Master or Layout changes must be reflected when slides are rendered.

## Domain contract

- **Template**: one reusable visual design package.
- **Master**: shared inherited frame and furniture for every Layout in a Template.
- **Layout**: one named arrangement of editable slots such as cover, content, or agenda.
- **Slide content**: the persisted editable slot contents plus explicit Template/Layout identifiers.
- **Rendered slide**: derived HTML composed from Master, Layout, and Slide content; it is not persisted as the slide source.

## Work

1. Define the package manifest and deterministic Master/Layout composition helpers.
2. Change project scaffolding, reading, validation, saving, export, and Agent instructions to the hierarchical format.
3. Convert built-in templates and current workspace projects to the new format without runtime legacy fallbacks.
4. Group the new-project and new-slide UI by Template and expose Layout selection separately.
5. Mark inherited rendered nodes as non-editable in ordinary slide editing while preserving editable slot content.
6. Add unit, integration, build, and browser-level coverage for inheritance, layout switching, creation, persistence, and export.

## Done criteria

- 年度末報告 appears once as a Template with cover/content/agenda Layouts.
- New projects start with the Template's explicit default Layout.
- New slides and existing slides select a Layout inside their Template.
- Editing Master/Layout files changes rendered existing slides without rewriting their slide content files.
- Slide edits persist only editable slot content and never duplicate inherited frame furniture.
- Production build, typecheck, lint, full tests, and UI tests pass.
