import { useReview } from "./hooks.js";

export interface ExportButtonProps {
  className?: string;
  /** Filename for the downloaded JSON. Defaults to `review.json`. */
  filename?: string;
  /** Inject for tests; defaults to a real browser download. */
  onExport?: (json: string) => void;
  label?: string;
}

/**
 * Single-button export: serializes the store's state as ReviewExportV1 JSON
 * and triggers a browser download (or hands it to the caller via onExport).
 */
export function ExportButton({
  className,
  filename = "review.json",
  onExport,
  label = "Export JSON",
}: ExportButtonProps) {
  const store = useReview();

  function handleClick() {
    const snapshot = store.export();
    const json = JSON.stringify(snapshot, null, 2);
    if (onExport) {
      onExport(json);
      return;
    }
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      data-amika="export-button"
    >
      {label}
    </button>
  );
}
