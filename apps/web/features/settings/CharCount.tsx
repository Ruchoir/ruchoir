import { charCount } from "@ruchoir/client/permissionsLogic";

/** The small "N/max" under a capped field, so the limit is seen before the typing stops at it. */
export function CharCount({ value, max }: { value: string; max: number }) {
  return (
    <div aria-hidden="true" style={{ textAlign: "right", fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
      {charCount(value, max)}
    </div>
  );
}
