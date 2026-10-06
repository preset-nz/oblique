import type { ReactElement } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** Hover delay before a param description appears — long enough that scrubbing past labels doesn't flash tooltips. */
export const LABEL_TIP_DELAY_MS = 500;

/**
 * Wraps a label element in a tooltip showing `description`. With no
 * description it returns the child untouched, so unannotated params render
 * exactly as before. Carries its own `TooltipProvider` (the app-level one
 * defaults to a zero delay) so the 500 ms delay holds wherever it is used.
 */
export function LabelTip({
  description,
  children,
}: {
  description?: string;
  children: ReactElement;
}) {
  if (!description) return children;
  return (
    <TooltipProvider delay={LABEL_TIP_DELAY_MS}>
      <Tooltip>
        <TooltipTrigger render={children} />
        <TooltipContent side="left">{description}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
