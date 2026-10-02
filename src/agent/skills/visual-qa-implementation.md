# Visual QA and implementation quality

- Produce the implementation when the brief is ready; do not stop at recommendations or a mock description.
- Keep markup semantic, styles maintainable, assets optimized, and JavaScript proportional to the behavior. Avoid regressions in loading, layout stability, and runtime cost.
- Render the requested slice in a real browser. Inspect at least one representative desktop and mobile viewport, plus any breakpoint where the composition materially changes.
- Check for overflow, clipping, overlap, accidental scrollbars, unreadable crops, broken focus, missing states, console errors, and failed resources.
- Run configured project checks. Distinguish their objective evidence from visual judgment: tests can prove rendering and constraints, while your visual review must explain what you inspected and why it passes.
- Review the changed-file list against the requested scope. In the completion report, summarize the implementation and explain material design decisions without claiming that automated scoring proves beauty.
