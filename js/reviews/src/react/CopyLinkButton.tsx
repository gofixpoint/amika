import { useState } from "react";
import { useReview } from "./hooks.js";
import type { ReviewLocation } from "../location/types.js";

export interface CopyLinkButtonProps {
  location: ReviewLocation;
  className?: string;
  label?: string;
  copiedLabel?: string;
  /**
   * Override the base href. By default uses `window.location.pathname` so
   * links round-trip in the same page. Pass an absolute URL for shareable
   * cross-machine links.
   */
  baseHref?: string;
  /** Inject for tests; defaults to `navigator.clipboard.writeText`. */
  writeClipboard?: (text: string) => Promise<void> | void;
}

/**
 * Copies a link for `location` to the clipboard. Used on item headers,
 * file rows, line gutter buttons, and comment threads.
 */
export function CopyLinkButton({
  location,
  className,
  label = "Copy link",
  copiedLabel = "Copied",
  baseHref,
  writeClipboard,
}: CopyLinkButtonProps) {
  const store = useReview();
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    const search = store.locationToSearch(location);
    const base =
      baseHref ??
      (typeof window === "undefined" ? "" : window.location.pathname);
    const text = base + (search ? "?" + search : "");
    const write =
      writeClipboard ?? ((t: string) => navigator.clipboard.writeText(t));
    await write(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      data-amika="copy-link"
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
