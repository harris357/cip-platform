// Slice 55: per-tool clarification templates.
//
// When an extractor returns `kind: 'missing'`, respond.ts looks up the
// template by tool name and renders a deterministic question — no LLM
// call. Saves the entire planner round-trip when the request is clear
// in intent but missing one piece of information.
//
// Templates are intentionally short. Format-specific hints live in
// the template (e.g., date format, role-code format) so the user knows
// what to type.

export const CLARIFICATION_BY_TOOL: Record<string, () => string> = {
  employee_disable: () =>
    `Who would you like to off-board? Reply with their name or email.`,
  employee_find: () =>
    `Find which employee? Reply with their email address.`,
  employee_list: () =>
    // employee_list shouldn't reach 'missing' (all args optional) but
    // include a template anyway for safety.
    `What kind of staff list — active employees, disabled, or everyone?`,
  get_my_certifications: () =>
    // Self-scoped — should never be 'missing'. Defensive.
    `I should be able to look up your own certifications. Try saying "show my certs".`,
  get_staff_certifications: () =>
    `Whose certifications? Reply with their name or email.`,
};
