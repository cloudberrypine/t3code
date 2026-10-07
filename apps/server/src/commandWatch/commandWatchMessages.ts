/** Lines a watch may print in a minute before T3 Code stops it as a flood. */
export const COMMAND_WATCH_FLOOD_LIMIT = 60;
/** Lines shown in one wake; the rest are counted. */
const LISTED_LINES = 30;
const LINE_LENGTH = 500;

function clip(line: string): string {
  return line.length <= LINE_LENGTH ? line : `${line.slice(0, LINE_LENGTH - 3)}...`;
}

/** Each output line, labelled with its watch. */
export function outputLines(label: string, lines: ReadonlyArray<string>): Array<string> {
  const shown = lines.slice(0, LISTED_LINES).map((line) => `[watch ${label}] ${clip(line)}`);
  if (lines.length > LISTED_LINES) {
    shown.push(`[watch ${label}] ... and ${lines.length - LISTED_LINES} more lines`);
  }
  return shown;
}

export function exitLines(
  label: string,
  exit: {
    readonly code: number | null;
    readonly reason: string | null;
    readonly stderr: ReadonlyArray<string>;
  },
): Array<string> {
  const how =
    exit.code !== null
      ? `exited with code ${exit.code}`
      : `stopped (${exit.reason ?? "no exit code"})`;
  const stderr = exit.stderr.filter((line) => line.trim().length > 0);
  return [
    `[watch ${label}] The command ${how}, so T3 Code stopped watching it. It is not restarted; call watch_command to start it again.`,
    ...(stderr.length === 0
      ? []
      : [`[watch ${label}] Last stderr lines:`, ...stderr.map((line) => `    ${clip(line)}`)]),
  ];
}

export function floodLines(label: string): Array<string> {
  return [
    `[watch ${label}] The command printed more than ${COMMAND_WATCH_FLOOD_LIMIT} lines in a minute, so T3 Code stopped it and stopped watching. Watch commands should print one line per event; fix the command and call watch_command to start it again.`,
  ];
}

export const restartedLine = (label: string) => `T3 Code restarted; watch ${label} restarted.`;

export const resumedLine = (label: string) => `The thread is active again; watch ${label} resumed.`;
