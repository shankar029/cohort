/**
 * Tool-access policy — enforces the catalog's per-agent tool allowlist at the SDK
 * level.
 *
 * The Copilot runtime offers every agent its full built-in toolset (view, grep,
 * write, edit, bash, powershell, …). Historically ateam only *claimed* to restrict
 * these — via the system prompt (`context.ts` canWrite/canRunCode) and the runtime
 * permission gate (`orchestrator.handlePermission`) — while the SDK still handed the
 * tools out. That mismatch produced a real dead-end: the Team Lead (which must never
 * mutate the workspace) would, when asked to "start the server", reach for
 * `powershell`, have the permission gate reject it, and its turn would end idle with
 * no answer — the user had to ping again to get a reply.
 *
 * We fix it at the source: never *offer* an agent a tool it isn't allowed to use.
 * The returned names are passed to the SDK's `excludedTools` (deny-wins, exact-name
 * match), so read-only roles keep `view/grep/glob` but lose `write`/shell.
 */

/**
 * Built-in file-mutating tools. The runtime exposes granular names (the catalog's
 * `write`/`edit` are abstract capability labels, not runtime tool names), so we
 * deny the real ones. Extra/non-existent names are harmless (deny-wins, exact match).
 */
export const WRITE_TOOLS = [
  'write',
  'create',
  'edit',
  'multi_edit',
  'str_replace',
  'str_replace_editor',
  'edit_file',
  'write_file',
  'create_file',
  'apply_patch',
];

/**
 * Built-in shell/command tools. These are a `<verb>_<shell>` FAMILY
 * (e.g. `read_powershell`, `list_powershell`, `write_bash`, `stop_shell`), not a
 * bare `bash`/`powershell` — so we generate the cross-product to catch every verb
 * variant across platforms. `<verb>_<shell>` never collides with the read tool
 * `read_file` (its noun isn't a shell).
 */
const SHELL_NOUNS = ['bash', 'powershell', 'shell', 'terminal', 'process'];
const SHELL_VERBS = ['read', 'write', 'list', 'stop', 'start', 'run', 'create', 'new', 'kill', 'exec', 'send'];
export const SHELL_TOOLS = [
  ...SHELL_NOUNS,
  ...SHELL_VERBS.flatMap((v) => SHELL_NOUNS.map((n) => `${v}_${n}`)),
];

/**
 * The `sql` session-store tool is a sandbox todos/history DB, NOT our board; an
 * agent that grabs it builds a phantom task list disconnected from ateam and can
 * rat-hole on FK errors. Always excluded.
 */
export const ALWAYS_DENIED = ['sql'];

/**
 * The built-in `task` tool spawns an ISOLATED SDK sub-agent that does NOT carry
 * ateam's custom tools (probe_app, the board/chat tools) and never touches the real
 * board. If the Lead uses it to "delegate", the shadow sub-agent can't actually run
 * anything ateam-specific and the real specialists are bypassed. The Lead delegates
 * through the board / `delegate` tool instead, so deny the shadow spawner.
 */
export const SUBAGENT_TOOLS = ['task'];

/**
 * Built-in tools to exclude for an agent, derived from its role and catalog tool
 * allowlist (`null` = full access). The Lead and read-only specialists lose
 * write + shell; spec/doc authors (write, no bash) lose only shell; full builders
 * (allowlist includes `bash`) lose nothing beyond `sql`.
 */
export function deniedBuiltinTools(role: 'lead' | 'specialist', tools: string[] | null): string[] {
  const isLead = role === 'lead';
  // Mirror context.ts capability logic: the Lead never writes/shells, regardless
  // of a null (full) allowlist; a specialist can if its allowlist permits.
  const canWrite = !isLead && (tools === null || tools.some((t) => t === 'write' || t === 'edit'));
  const canShell = !isLead && (tools === null || tools.includes('bash'));
  const denied = [...ALWAYS_DENIED];
  if (isLead) denied.push(...SUBAGENT_TOOLS);
  if (!canShell) denied.push(...SHELL_TOOLS);
  if (!canWrite) denied.push(...WRITE_TOOLS);
  return denied;
}
