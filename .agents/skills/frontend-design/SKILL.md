---
name: frontend-design
description: Implement polished production frontend for Auto-Cuan while respecting the existing design language and application behavior. Use for page/component creation, visual redesign, responsive styling, and interaction polish.
---

# Frontend Design

Create production-quality UI rather than placeholder-looking interface work.

## Process

1. Inspect the existing page/component, CSS strategy, reusable components, icons, fonts, spacing, and responsive conventions.
2. Define the visual intent in a few words before implementation: e.g. dense trading dashboard, calm account center, compact admin tool.
3. Build around the actual content hierarchy and user tasks.
4. Reuse the project's components and styling system when they are suitable.
5. Add custom styling only where it materially improves clarity or consistency.

## Quality bar

- Strong hierarchy without excessive visual effects.
- Deliberate typography and spacing.
- Responsive layout that survives narrow screens and long content.
- Clear hover/focus/pressed/loading/disabled states.
- Semantic and accessible markup.
- No fake data merely to make a layout look populated.
- No removal of important status, validation, or risk information for aesthetics.

For Auto-Cuan financial surfaces, legibility and correctness outrank novelty. Keep numbers easy to compare, preserve units and signs, and do not use decorative treatment that can be confused with trading status or risk state.
