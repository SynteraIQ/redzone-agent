import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type TypeScriptImpact = {
  status: "analyzed" | "skipped";
  changedFiles: string[];
  directDependents: string[];
  transitiveDependents: string[];
  filesScanned: number;
  importEdges: number;
  note: string;
};

function git(repositoryPath: string, args: string[]): string {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
}

function readCompilerOptions(repositoryPath: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(repositoryPath, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    };
  }

  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    return {
      allowJs: true,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    };
  }

  return ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
  ).options;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifiers.push(node.moduleReference.expression.text);
    }
    if (
      ts.isCallExpression(node) && node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
}

function isTypeScriptSource(filePath: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/.test(filePath) && !filePath.endsWith(".d.ts");
}

function sorted(values: Set<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function readWorkspaceModuleMap(
  repositoryPath: string,
  trackedFiles: string[],
): Map<string, string> {
  const packages: Array<{ root: string; name: string }> = [];
  for (const manifestPath of trackedFiles.filter((filePath) => filePath.endsWith("package.json"))) {
    const absolutePath = path.resolve(repositoryPath, manifestPath);
    if (!existsSync(absolutePath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string") {
        const root = path.dirname(manifestPath).split(path.sep).join("/");
        packages.push({ root: root === "." ? "" : root, name: manifest.name });
      }
    } catch {
      // Invalid or generated manifests do not contribute workspace mappings.
    }
  }

  const workspaceModules = new Map<string, string>();
  for (const sourcePath of trackedFiles.filter(isTypeScriptSource)) {
    const normalizedPath = sourcePath.split(path.sep).join("/");
    const owner = packages
      .filter(({ root }) => normalizedPath.startsWith(root ? `${root}/` : ""))
      .sort((left, right) => right.root.length - left.root.length)[0];
    if (!owner) continue;

    const sourcePrefix = owner.root ? `${owner.root}/src/` : "src/";
    if (!normalizedPath.startsWith(sourcePrefix)) continue;

    const sourceName = normalizedPath.slice(sourcePrefix.length)
      .replace(/\.(?:ts|tsx|mts|cts)$/, "")
      .replace(/(?:^|\/)index$/, "");
    const moduleName = sourceName ? `${owner.name}/${sourceName}` : owner.name;
    workspaceModules.set(moduleName, normalizedPath);
  }
  return workspaceModules;
}

export function analyzeTypeScriptImpact(
  repositoryPath: string,
  changedFiles: string[],
): TypeScriptImpact {
  const changedTypeScriptFiles = changedFiles
    .filter(isTypeScriptSource)
    .map((filePath) => filePath.split(path.sep).join("/"));

  if (changedTypeScriptFiles.length === 0) {
    return {
      status: "skipped",
      changedFiles: [],
      directDependents: [],
      transitiveDependents: [],
      filesScanned: 0,
      importEdges: 0,
      note: "No changed TypeScript source files were found.",
    };
  }

  const trackedFiles = git(repositoryPath, ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"])
    .split("\0")
    .filter((filePath) => isTypeScriptSource(filePath));
  const trackedFileSet = new Set(trackedFiles.map((filePath) => filePath.split(path.sep).join("/")));
  const workspaceModules = readWorkspaceModuleMap(repositoryPath, [
    ...trackedFiles,
    ...git(repositoryPath, ["ls-files", "-z", "--", "package.json", ":(glob)**/package.json"])
      .split("\0").filter(Boolean),
  ]);
  const options = readCompilerOptions(repositoryPath);
  const resolutionHost = ts.createCompilerHost(options);
  const resolutionCache = ts.createModuleResolutionCache(repositoryPath, (value) => value, options);
  const reverseEdges = new Map<string, Set<string>>();
  let importEdges = 0;
  let filesScanned = 0;

  for (const relativeFile of trackedFiles) {
    const absoluteFile = path.resolve(repositoryPath, relativeFile);
    if (!existsSync(absoluteFile)) continue;
    filesScanned++;
    const sourceText = readFileSync(absoluteFile, "utf8");
    const sourceFile = ts.createSourceFile(
      absoluteFile,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      relativeFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const importer = relativeFile.split(path.sep).join("/");

    for (const specifier of moduleSpecifiers(sourceFile)) {
      const normalizedSpecifier = specifier.replace(/\.(?:m?js|cjs|tsx?|mts|cts)$/, "");
      const workspaceResolved = workspaceModules.get(normalizedSpecifier);
      const resolved = workspaceResolved
        ? path.resolve(repositoryPath, workspaceResolved)
        : ts.resolveModuleName(
        specifier,
        absoluteFile,
        options,
        resolutionHost,
        resolutionCache,
        ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;

      const dependency = path.relative(repositoryPath, resolved).split(path.sep).join("/");
      if (!trackedFileSet.has(dependency)) continue;

      const importers = reverseEdges.get(dependency) ?? new Set<string>();
      if (!importers.has(importer)) {
        importers.add(importer);
        importEdges++;
      }
      reverseEdges.set(dependency, importers);
    }
  }

  const changedSet = new Set(changedTypeScriptFiles);
  const directDependents = new Set<string>();
  const transitiveDependents = new Set<string>();
  const visited = new Set(changedTypeScriptFiles);
  const queue = changedTypeScriptFiles.map((filePath) => ({ filePath, depth: 0 }));
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const current = queue[queueIndex++];
    if (!current) continue;

    for (const dependent of reverseEdges.get(current.filePath) ?? []) {
      if (changedSet.has(dependent)) continue;
      if (current.depth === 0) directDependents.add(dependent);
      else transitiveDependents.add(dependent);
      if (visited.has(dependent)) continue;
      visited.add(dependent);
      queue.push({ filePath: dependent, depth: current.depth + 1 });
    }
  }

  for (const direct of directDependents) transitiveDependents.delete(direct);

  return {
    status: "analyzed",
    changedFiles: changedTypeScriptFiles,
    directDependents: sorted(directDependents),
    transitiveDependents: sorted(transitiveDependents),
    filesScanned,
    importEdges,
    note: "AST import and re-export edges show file-level reachability, including workspace package source imports where available; they do not prove symbol-level usage or safe deletion.",
  };
}
