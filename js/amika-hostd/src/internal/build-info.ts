/**
 * Build metadata for `amika-hostd version`, in the format the Go CLIs print
 * (`go/internal/buildmeta`).
 *
 * `scripts/bundle.mjs` replaces `__AMIKA_HOSTD_BUILD__` with a literal at
 * bundle time, as `go build -ldflags -X` does for the Go binaries. Run from
 * source (`tsx`, vitest) nothing replaces it, so the build reads as `dev`.
 */
declare const __AMIKA_HOSTD_BUILD__: {
  version: string;
  commit: string;
  date: string;
};

/** This build's version, commit and date, as `amika version` prints them. */
export function versionText(): string {
  const build =
    typeof __AMIKA_HOSTD_BUILD__ === "undefined"
      ? undefined
      : __AMIKA_HOSTD_BUILD__;
  return [
    `version: ${build?.version || "dev"}`,
    `commit: ${build?.commit || "unknown"}`,
    `date: ${build?.date || "unknown"}`,
  ].join("\n");
}
