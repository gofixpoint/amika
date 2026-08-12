const LOCKFILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
]);

const FORMATTABLE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".yaml",
  ".yml",
]);

const PACKAGE_BY_PREFIX = [["js/sandbox/", "@amika/sandbox"]];

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function shouldFormat(path) {
  const normalizedPath = normalizePath(path);
  const fileName = normalizedPath.split("/").at(-1) ?? "";
  if (LOCKFILE_NAMES.has(fileName)) {
    return false;
  }

  const extension = fileName.includes(".")
    ? `.${fileName.split(".").at(-1)}`
    : "";
  return FORMATTABLE_EXTENSIONS.has(extension);
}

function shellQuote(path) {
  return JSON.stringify(path);
}

function getTouchedPackages(paths) {
  const packages = new Set();
  for (const path of paths.map(normalizePath)) {
    for (const [prefix, packageName] of PACKAGE_BY_PREFIX) {
      if (path.startsWith(prefix)) {
        packages.add(packageName);
      }
    }
  }
  return [...packages];
}

export default {
  "js/**/*": (stagedPaths) => {
    const pathsToFormat = stagedPaths.filter(shouldFormat);
    if (pathsToFormat.length === 0) {
      return [];
    }

    const quotedPaths = pathsToFormat.map(shellQuote).join(" ");
    // Pin to the workspace prettier version (the single `prettier` resolved in
    // pnpm-lock.yaml). This MUST match every package's `prettier` devDependency
    // so hook-written formatting is identical to what CI's `formatcheck` (which
    // runs the workspace prettier) expects. Bump both together.
    //
    // This constraint now has to hold independently in amika-mono, whose
    // .lintstagedrc.mjs carries the same pin: this package is consumed there as
    // a git submodule, and a formatting disagreement between the two repos
    // would surface as a `formatcheck` failure in whichever one did not write
    // the file. Bump both repos together.
    return [`pnpm dlx prettier@3.8.3 --write ${quotedPaths}`];
  },
  "js/**": (stagedPaths) => {
    const touchedPackages = getTouchedPackages(stagedPaths);
    if (touchedPackages.length === 0) {
      return [];
    }

    return touchedPackages.flatMap((packageName) => [
      `pnpm --filter ${packageName} run lint`,
      `pnpm --filter ${packageName} run typecheck`,
    ]);
  },
};
