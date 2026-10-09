/**
 * Single source of truth for sprint card lint rules.
 * Imported by parse-sprint-folder.mjs; contract §5 documents the same set.
 */

/** `[x](foo.md)` links, or bare `docs/plan/foo.md` style paths (outside backticks). */
export const MD_LINK_RE = new RegExp(
  '\\]\\([^)\\s]*\\.md(?:#[^)\\s]*)?\\)' +
    '|(?:^|[\\s(`\'"])(?:\\.{1,2}/)?(?:[\\w.-]+/)+[\\w.-]+\\.md\\b',
);

export const VAGUE_RULES = [
  [/\bmaybe\b/i, 'maybe'],
  [/\bconsider\b/i, 'consider'],
  [/\bmight want to\b/i, 'might want to'],
  [/\bexplore whether\b/i, 'explore whether'],
  [/\binvestigate if\b/i, 'investigate if'],
  [/\bTBD\b/, 'TBD'],
  [/TODO:/, 'TODO:'],
  [/\blook into\b/i, 'look into'],
  [/^\s*[-*+]\s+\[[ xX]\]\s+research\b/i, 'Research (task item)'],
];

export const AI_TELL_RULES = [
  [/\bClaude\b/, 'Claude'],
  [/\bCursor\b/, 'Cursor'],
  [/\bChatGPT\b/i, 'ChatGPT'],
  [/\bCopilot\b/, 'Copilot'],
  [/\bAs an AI\b/i, 'As an AI'],
  [/\bLLMs?\b/, 'LLM'],
  [/\bsubagents?\b/i, 'subagent'],
  [/\bMCP\b/, 'MCP'],
  [/\badversarial\b/i, 'adversarial'],
  [/\bauto-?generated\b/i, 'auto-generated'],
  [/\bworkflow dispatch\b/i, 'workflow dispatch'],
];

export const REL_LINK_RE = /\[[^\]]*\]\(\s*(?!https?:\/\/)[^)]+\)/;
export const IMG_MARKDOWN_RE = /!\[[^\]]*\]\([^)]+\)/;

export const MEDIA_TELL_RE = [
  [/\bscreenshots?\b/i, 'screenshot reference'],
  [/\battached PNG\b/i, 'attached PNG'],
  [/\bupload (?:to )?Jira\b/i, 'upload to Jira'],
  [/\bsee attachment\b/i, 'see attachment'],
  [/\baudit-evidence\b/i, 'audit-evidence path'],
  [/\bREMOVED-CARDS\b/i, 'REMOVED-CARDS'],
  [/\b_validat(?:ion|ed)\b.*\.md\b/i, 'validation doc pointer'],
];

export const PM_FOLDER_RE =
  /(?:^|[\s('"`])\.{0,2}\/?(?:_internal|docs\/(?:reviews|plan)|sprint_planning)\//i;

export const PROCESS_META_RE = [
  [/\bPM must sign off\b/i, 'PM sign-off process'],
  [/\bdo not start until\b.*\bready\b/i, 'cross-file gate in card body'],
  [/\bsee subtask\s+[\d.a-z]+\b/i, 'see other card'],
  [/\bsee US\s*\d/i, 'see other card'],
  [/\bhow (?:this|we) generated\b/i, 'generation meta'],
];

/** Contract §5 “group 2” — enforced in lint (critics still catch nuance). */
export const CONTRACT_PHRASE_RULES = [
  [/\bspike\b/i, 'spike'],
  [/\bevaluate options\b/i, 'evaluate options'],
  [/\bworks correctly\b/i, 'works correctly'],
  [/\blooks good\b/i, 'looks good'],
  [/\buser-friendly\b/i, 'user-friendly'],
  [/\bhandle edge cases\b/i, 'handle edge cases'],
  [/\bper the overview\b/i, 'per the overview'],
  [/\bonce US\d/i, 'once USx is merged'],
  [/\bPhase 0\b/, 'Phase 0'],
  [/\brollback plan\b/i, 'rollback plan'],
  [/\bmodel output\b/i, 'model output'],
  [/\{\{[^}]+\}\}/, 'template placeholder'],
  [/\[Cancelled\]/i, 'Cancelled prefix'],
];

export const MAX_TASK_ITEM_CHARS = 200;
export const MAX_STORY_DESCRIPTION_CHARS = 6000;
