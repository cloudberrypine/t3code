import type { Ref } from "react";

import { InputGroup, InputGroupInput } from "~/components/ui/input-group";

export function FileSearchField({
  inputRef,
  ariaLabel,
  name,
  onClose,
  onValueChange,
  value,
}: {
  inputRef?: Ref<HTMLInputElement>;
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        ref={inputRef}
        type="search"
        name={name}
        size="sm"
        value={value}
        aria-label={ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onClose();
          event.currentTarget
            .closest<HTMLElement>("[data-find-pane]")
            ?.focus({ preventScroll: true });
        }}
      />
    </InputGroup>
  );
}
