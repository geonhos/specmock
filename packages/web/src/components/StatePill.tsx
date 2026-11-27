import { Badge } from "@astryxdesign/core/Badge";
import type { StepState } from "@specmock/ui-server/api-types";
import { STATE_LABEL, STATE_SYMBOL } from "../flowModel";

/** One of the 8 step states: colour (`.st-<state>`), glyph and text together. */
export function StatePill({ state }: { state: StepState }) {
  return <Badge variant="neutral" className={`st st-${state}`} icon={STATE_SYMBOL[state]} label={STATE_LABEL[state]} />;
}
