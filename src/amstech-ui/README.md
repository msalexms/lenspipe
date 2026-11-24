# Shared UI styles

The design tokens, base components and fonts used by every LensPipe page. They are imported from `src/shared.css` and bundled by Vite, so nothing is loaded from outside (compatible with the strict `'self'` CSP).

| File | Contents |
| --- | --- |
| `tokens.css` | CSS variables: colors, borders, radii, shadows, spacing, font stacks |
| `componentes.css` | Base components (`ams-` prefix): boxes, buttons, switches, segments, ranges, dialogs |
| `fuentes.css` | `@font-face` rules for the files in `fuentes/` |
| `fuentes/` | WOFF2 fonts (Latin + Latin Extended) |

LensPipe-specific styles live in `src/shared.css` and the per-page stylesheets, not here. Small JS helpers (range painting, steps bar, dialog backdrop close) are in `src/amstech-ui.ts`.

## Fonts

Bricolage Grotesque, Figtree and DM Mono, from Fontsource 5.3.0, under the SIL Open Font License 1.1. The license texts are in `fuentes/LICENCIA-*.txt`.
