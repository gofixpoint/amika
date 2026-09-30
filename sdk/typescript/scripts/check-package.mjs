import assert from "node:assert/strict";
import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import ts from "typescript";

// Test an installed consumer layout using precisely the declared package files.
// This deliberately does not use the repository's @/* path aliases.
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "amika-sdk-consumer-"));
try {
  const pkg = path.join(temp, "node_modules/@amika/sdk");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  fs.mkdirSync(pkg, { recursive: true });
  for (const item of manifest.files)
    fs.cpSync(path.join(root, item), path.join(pkg, item), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(manifest));
  fs.writeFileSync(path.join(temp, "package.json"), '{"type":"module"}');
  const filename = path.join(temp, "consumer.ts");
  const source = `
import { AmikaClient, AmikaHTTPError, AmikaWaitError, type Rig, type RigHandle,
  type CreateRigRequest, type RemoteRig, type Sandbox, type RemoteSandbox,
  type SandboxSnapshot, type RigWaitOptions, type AgentSession } from "@amika/sdk";
// @ts-expect-error Retired runtime exports are no longer public.
import { StaticTokenSource, RESERVED_PORT_MIN, RESERVED_PORT_MAX, validateServicePort } from "@amika/sdk";
// @ts-expect-error Internal transport is not an exported package subpath.
import { HTTPClient } from "@amika/sdk/dist/internal/http.js";
const client = new AmikaClient({ apiKey: "example" });
const handle: RigHandle = client.rigs.handle("dev");
// @ts-expect-error Unchecked handles do not pretend to contain fetched metadata.
handle.status;
const pending: Promise<Rig> = client.rigs.get("dev");
// @ts-expect-error get returns an ordinary Promise; await before calling resource methods.
pending.wait();
const ready: Promise<Rig> = client.rigs.getAndWait("dev", { maxWaitMs: 1000 });
const request: CreateRigRequest = { repoUrl: "https://github.com/org/repo", autoStopInterval: 30 };
async function example() {
  const rig = await client.rigs.create(request);
  await rig.wait();
  const data: RemoteRig = rig;
  const legacy: Sandbox = rig;
  const legacyData: RemoteSandbox = data;
  const chat: AgentSession = await client.agentSessions.get("chat1");
  await chat.send({ message: "continue", model: null });
  const snapshot = await client.snapshots.create({ rigRef: rig.id, name: "base", mode: "full" });
  const oldSnapshot: SandboxSnapshot = snapshot;
  await snapshot.wait();
  return { legacy, legacyData, oldSnapshot };
}
`;
  fs.writeFileSync(filename, source);
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ]) {
    const options = {
      target: ts.ScriptTarget.ES2022,
      module,
      moduleResolution,
      strict: true,
      noEmit: true,
      types: [],
    };
    const program = ts.createProgram([filename], options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => temp,
        getCanonicalFileName: (f) => f,
        getNewLine: () => "\n",
      }),
    );
    // Declaration maps open these sources in the editor. Their imports must
    // also resolve without the SDK repository's TypeScript path aliases.
    const sourceProgram = ts.createProgram(
      [path.join(pkg, "src/index.ts")],
      options,
    );
    const sourceDiagnostics = ts.getPreEmitDiagnostics(sourceProgram);
    assert.equal(
      sourceDiagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(sourceDiagnostics, {
        getCurrentDirectory: () => temp,
        getCanonicalFileName: (f) => f,
        getNewLine: () => "\n",
      }),
    );
    const checker = program.getTypeChecker();
    const entry = program.getSourceFile(path.join(pkg, "dist/index.d.ts"));
    assert.ok(entry, "package types entry point must resolve");
    const symbols = checker.getExportsOfModule(
      checker.getSymbolAtLocation(entry),
    );
    for (const name of [
      "Sandbox",
      "CreateSandboxRequest",
      "CreateSandboxSnapshotRequest",
      "RemoteSandbox",
      "RemoteSandboxCreator",
      "RemoteSandboxService",
      "SandboxScrubPreview",
      "SandboxServiceRequest",
      "SandboxServiceResource",
      "SandboxSnapshot",
    ]) {
      const exported = symbols.find((s) => s.name === name);
      assert.ok(exported, `${name} must remain exported`);
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      assert.ok(
        target.getJsDocTags(checker).some((t) => t.name === "deprecated"),
        `${name} must be deprecated in editor tooling`,
      );
    }
    const service = ts.createLanguageService({
      ...ts.sys,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      getCompilationSettings: () => options,
      getCurrentDirectory: () => temp,
      getScriptFileNames: () => [filename],
      getScriptVersion: () => "0",
      getScriptSnapshot: (file) => {
        const text = ts.sys.readFile(file);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
    });
    for (const [text, expected] of [
      ["getAndWait", /deadline/],
      ["autoStopInterval", /minutes/],
    ]) {
      const pos = source.indexOf(text) + 1;
      const info = service.getQuickInfoAtPosition(filename, pos);
      assert.match(
        ts.displayPartsToString(info?.documentation),
        expected,
        `${text} hover must describe its behavior`,
      );
      const definitions = service.getDefinitionAtPosition(filename, pos);
      assert.ok(
        definitions?.some(
          (d) => d.fileName.startsWith(pkg) && d.fileName.endsWith(".d.ts"),
        ),
        `${text} must navigate to a shipped definition`,
      );
    }
    service.dispose();
  }
  const runtime = await import(
    pathToFileURL(path.join(pkg, "dist/index.js")).href
  );
  assert.deepEqual(
    Object.keys(runtime).sort(),
    ["AmikaClient", "AmikaError", "AmikaHTTPError", "AmikaWaitError"].sort(),
  );
  function checkMaps(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) checkMaps(file);
      else if (file.endsWith(".d.ts.map")) {
        const map = JSON.parse(fs.readFileSync(file, "utf8"));
        for (const source of map.sources) {
          const resolved = path.resolve(
            path.dirname(file),
            map.sourceRoot ?? "",
            source,
          );
          assert.ok(
            resolved.startsWith(pkg + path.sep) && fs.existsSync(resolved),
            `declaration map must resolve inside the installed package: ${file}`,
          );
        }
      }
    }
  }
  checkMaps(path.join(pkg, "dist"));
  console.log(
    "Consumer checks passed: exports, compatibility types, NodeNext/Bundler resolution, hover documentation, definitions, and declaration-map sources.",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
