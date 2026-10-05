import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function FilteredDiffStatLabel({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="group"
            aria-label={`Filtered total: ${additions} additions, ${deletions} deletions`}
            className="inline-flex items-center font-mono tabular-nums text-muted-foreground"
          />
        }
      >
        (<span className="text-success">+{additions.toLocaleString()}</span>,&nbsp;
        <span className="text-destructive">-{deletions.toLocaleString()}</span>)
      </TooltipTrigger>
      <TooltipPopup>Total excluding files matched by .t3diffignore</TooltipPopup>
    </Tooltip>
  );
}
