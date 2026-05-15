import { useRef, useState, type DragEvent } from "react";
import { useReview } from "./hooks.js";

export interface UploadDropzoneProps {
  className?: string;
  /** Called after files have been parsed and added to the store. */
  onLoaded?: (count: number) => void;
  children?: React.ReactNode;
}

/**
 * Accepts `.diff` / `.patch` files via drag-and-drop or the native file picker
 * and loads them into the store. Each dropped file becomes one ReviewItem
 * (kind: "patch"). Files with other extensions are still accepted as text so
 * users can paste raw patch bodies.
 */
export function UploadDropzone({
  className,
  onLoaded,
  children,
}: UploadDropzoneProps) {
  const store = useReview();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function load(files: FileList | File[] | null) {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const items = await store.loadFromFiles(arr);
    onLoaded?.(items.length);
  }

  return (
    <div
      className={className}
      data-amika="upload-dropzone"
      data-amika-drag-over={dragOver}
      onDragOver={(e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDragOver(false);
        void load(e.dataTransfer.files);
      }}
    >
      {children ?? (
        <div data-amika="upload-dropzone-default">
          Drop .diff or .patch files here, or
          <button type="button" onClick={() => inputRef.current?.click()}>
            choose files
          </button>
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".diff,.patch,text/plain"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          void load(e.target.files);
          e.target.value = "";
        }}
        data-amika="upload-dropzone-input"
      />
    </div>
  );
}
