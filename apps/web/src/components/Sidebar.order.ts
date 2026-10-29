/** The rendered computer blocks, followed by the global snoozed and settled shelves. */
export function sidebarVisibleOrder<T>(input: {
  readonly computers:
    | readonly { readonly environmentId: string; readonly sections: readonly (readonly T[])[] }[]
    | null;
  readonly collapsed: readonly string[];
  readonly singleSections: readonly (readonly T[])[];
  readonly children: (row: T) => readonly T[];
  readonly shelves: readonly (readonly T[])[];
}): T[] {
  const flatten = (rows: readonly T[]): T[] =>
    rows.flatMap((row) => [row, ...flatten(input.children(row))]);
  const sections =
    input.computers === null
      ? input.singleSections
      : input.computers
          .filter((computer) => !input.collapsed.includes(computer.environmentId))
          .flatMap((computer) => computer.sections);
  return [...sections.flatMap(flatten), ...input.shelves.flat()];
}
