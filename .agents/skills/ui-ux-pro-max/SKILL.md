---
name: ui-ux-pro-max
description: High-quality UI/UX design and implementation guidance for Auto-Cuan web surfaces. Use for dashboards, modals, forms, tables, responsive layouts, visual polish, accessibility, and interaction design.
---

# UI/UX Pro Max — Auto-Cuan Cloud Edition

Design interfaces that are clear, fast, trustworthy, responsive, and consistent with the existing product.

## Before changing UI

1. Inspect the current component, styles, design tokens, neighboring screens, and actual user flow.
2. Preserve established patterns unless the task specifically asks for a redesign.
3. Identify the primary user action, secondary actions, dangerous actions, loading states, empty states, error states, and mobile behavior.
4. Do not hide important trading, payment, account, or risk information for visual simplicity.

## Visual hierarchy

- Make the primary action obvious without making every element visually loud.
- Use spacing, typography, alignment, and grouping before adding decoration.
- Keep dense financial data scannable with consistent columns, number alignment, labels, units, and state colors already used by the project.
- Avoid gratuitous gradients, glass effects, oversized cards, excessive shadows, and animation that competes with data.
- Prefer a small coherent token set over one-off values.

## Interaction

- Make controls discoverable and keyboard reachable.
- Provide clear disabled, loading, success, warning, and failure states.
- Prevent double-submit and ambiguous destructive actions.
- Keep modal flows contained when the user should not lose context.
- Preserve entered data on recoverable errors when safe.
- For async operations, show progress and final state without creating duplicate actions.

## Accessibility

- Use semantic elements and labels.
- Maintain visible focus states.
- Do not communicate status by color alone.
- Ensure text/control contrast is sufficient.
- Use descriptive button text for consequential actions.
- Respect reduced-motion behavior when animation is added.

## Responsive behavior

- Design mobile behavior intentionally rather than shrinking desktop.
- Keep primary actions reachable.
- Allow tables to scroll or transform without losing headers/context.
- Avoid fixed dimensions that clip Indonesian text or financial values.

## Implementation quality

- Reuse existing components and tokens first.
- Avoid CSS duplication and arbitrary z-index escalation.
- Test key widths and long/empty/error content.
- Do not change business logic while doing visual cleanup unless required by the task.
- Finish by checking the actual rendered hierarchy, not only the source code.
