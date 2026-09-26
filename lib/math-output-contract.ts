import { mathCapabilityPrompt } from './math-capabilities.mjs';
/** The same transcription protocol is used by all recognition entry points. */
export const mathOutputRequirements = [
  mathCapabilityPrompt,
  "Every mathematical expression must use standard LaTeX with explicit delimiters: $...$ for inline math; $$...$$ for a standalone derivation. Keep prose and source language unchanged outside math.",
  "Use \\frac{...}{...}, \\sqrt{...}, ^{...}, and _{...}. Do not use Unicode superscripts/subscripts or bare LaTeX without delimiters. Preserve every sign, absolute-value bar and grouping from the source.",
  "Use ordinary \\frac rather than \\dfrac or \\tfrac. Do not emit sizing commands such as \\displaystyle, \\textstyle, \\small, \\large or \\Huge: the application controls typography, not the model.",
  "Keep each delimited formula on one logical text line. For separate derivation lines use separate complete $$...$$ blocks; use \\begin{aligned}...\\end{aligned} or \\begin{cases}...\\end{cases} only when structurally necessary, and close all braces and delimiters.",
  "Escape all LaTeX backslashes correctly in JSON strings. Never output control characters. Formatting requirements must not change, solve, simplify, repair, omit or invent any mathematical content; put uncertainty in warnings.",
];
