// PolyCode additions to the T3 orchestration instructions, kept apart from upstream's text so
// nightly merges stay easy. Codex truncates entries over 4,000 bytes; keep this section below that.
export const T3_CODE_LOCAL_ORCHESTRATION_SECTION = `### Watches and settling

- \`watch_command\` runs a long-lived command for this thread and wakes you with each stdout line, with no time limit. Use it, not your harness's time-limited monitors, background shells or sleep loops, then end your turn. It survives restarts, pauses while the thread is settled, and ends when the command exits (you get the code) or the thread is archived. \`list_command_watches\` lists them, \`unwatch_command\` stops one.
- \`t3_thread_organize\` \`settle_after_run\` settles this thread once your run completes and nothing is pending: queued messages, questions, background work, running children, unsettled nested threads, watches. Make it your last step when the work is done. A plain \`settle\` waits only for the turn. A new message cancels it, as does \`cancel_settle_after_run\`.`;
