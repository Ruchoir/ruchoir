import type { Ref, TextareaHTMLAttributes } from "react";

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  seamless?: boolean;
  invalid?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
};

/** Multiline field. `seamless` for the message composer. */
export function Textarea({
  rows = 3,
  seamless,
  invalid,
  className = "",
  ref,
  ...rest
}: TextareaProps) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={`wc-ta${seamless ? " wc-ta--seamless" : ""}${invalid ? " wc-ta--invalid" : ""} ${className}`}
      {...rest}
    />
  );
}
