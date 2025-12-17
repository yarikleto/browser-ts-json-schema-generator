import ts from "../src/ts.js";
import type { CompletedConfig } from "../src/Config.js";
import { BuildError } from "../src/Error/Errors.js";

type FileMap = Record<string, string>;

function normalizeFileName(fileName: string): string {
    // Keep it very simple and platform-agnostic for browser usage.
    // Treat all paths as posix-like and avoid relying on process.cwd()/path.
    return fileName.replace(/\\/g, "/");
}

function createInMemoryCompilerHost(files: FileMap, options: ts.CompilerOptions): ts.CompilerHost {
    const normalized: FileMap = {};
    for (const [k, v] of Object.entries(files)) {
        normalized[normalizeFileName(k)] = v;
    }

    const getText = (fileName: string): string | undefined => normalized[normalizeFileName(fileName)];

    const hasFile = (fileName: string): boolean => getText(fileName) !== undefined;

    const tryResolveProvidedFile = (candidates: string[]): string | undefined => {
        for (const c of candidates) {
            const n = normalizeFileName(c);
            if (hasFile(n)) return n;
        }
        return undefined;
    };

    const pickDefaultLibFileName = (opts: ts.CompilerOptions): string => {
        // If the user provided TypeScript lib sources in-memory, prefer TS's default lib name *if present*.
        // Otherwise fall back to common names in the provided lib map (e.g. "lib.d.ts" for tiny synthetic libs).
        const tsDefault = normalizeFileName(ts.getDefaultLibFileName(opts));
        if (getText(tsDefault) !== undefined) return tsDefault;

        const libDotTs = Object.keys(normalized).find((k) => /(^|\/)lib\.d\.ts$/.test(k));
        if (libDotTs && getText(libDotTs) !== undefined) return libDotTs;

        const libLike = Object.keys(normalized).filter((k) => /(^|\/)lib\..*\.d\.ts$/.test(k)).sort();
        if (libLike.length && getText(libLike[0]) !== undefined) return libLike[0];

        // Last resort: ask TypeScript for its default. If the file isn't provided, TS will emit diagnostics.
        return tsDefault;
    };

    const host: ts.CompilerHost = {
        fileExists: (fileName: string) => hasFile(fileName),
        readFile: (fileName: string) => getText(fileName),
        getSourceFile: (
            fileName: string,
            languageVersion: ts.ScriptTarget,
            onError?: (message: string) => void,
        ) => {
            const text = getText(fileName);
            if (text === undefined) {
                onError?.(`File not found: ${fileName}`);
                return undefined;
            }
            return ts.createSourceFile(fileName, text, languageVersion, true);
        },
        getDefaultLibFileName: (opts: ts.CompilerOptions) => pickDefaultLibFileName(opts),
        writeFile: () => {
            /* no-op */
        },
        getCurrentDirectory: () => "/",
        getDirectories: () => [],
        directoryExists: () => true,
        getCanonicalFileName: (fileName: string) => normalizeFileName(fileName),
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
    };

    // Module resolution needs a host too. We resolve exclusively from the in-memory map.
    const moduleResolutionHost: ts.ModuleResolutionHost = {
        fileExists: host.fileExists,
        readFile: host.readFile,
        directoryExists: host.directoryExists,
        getCurrentDirectory: host.getCurrentDirectory,
        getDirectories: host.getDirectories,
        realpath: (p: string) => p,
    };

    host.resolveModuleNames = (moduleNames: string[], containingFile: string) => {
        return moduleNames.map((moduleName) => {
            const resolved = ts.resolveModuleName(moduleName, containingFile, options, moduleResolutionHost);
            return resolved.resolvedModule;
        });
    };

    // Support `compilerOptions.types` / triple-slash `/// <reference types="..."/>` in VFS mode.
    // TypeScript normally resolves these from `typeRoots` (e.g. node_modules/@types). In browser/VFS mode
    // we can only resolve from the provided in-memory file map.
    host.resolveTypeReferenceDirectives = (
        typeDirectiveNames: string[] | readonly ts.FileReference[],
        containingFile: string,
        _redirectedReference: ts.ResolvedProjectReference | undefined,
        _options: ts.CompilerOptions,
        _containingFileMode?: ts.ResolutionMode,
    ): (ts.ResolvedTypeReferenceDirective | undefined)[] => {
        const dirs = typeDirectiveNames as readonly (string | ts.FileReference)[];
        return dirs.map((dir) => {
            const name = typeof dir === "string" ? dir : dir.fileName;
            const normalizedName = normalizeFileName(name);

            // Allow passing file-like names (including ".d.ts") in `compilerOptions.types`, e.g. "context.d.ts".
            const candidates: string[] = [];
            candidates.push(normalizedName);
            candidates.push("/" + normalizedName.replace(/^\//, ""));

            if (!/\.d\.ts$/.test(normalizedName)) {
                candidates.push(normalizedName + ".d.ts");
                candidates.push("/" + normalizedName.replace(/^\//, "") + ".d.ts");
            }

            // Also support a common "index.d.ts" pattern if caller provides a folder.
            candidates.push(normalizedName.replace(/\/?$/, "/") + "index.d.ts");
            candidates.push("/" + normalizedName.replace(/^\//, "").replace(/\/?$/, "/") + "index.d.ts");

            const resolvedFileName = tryResolveProvidedFile(candidates);
            if (!resolvedFileName) return undefined;

            return {
                resolvedFileName,
                primary: true,
            } satisfies ts.ResolvedTypeReferenceDirective;
        });
    };

    return host;
}

function getDefaultCompilerOptions(): ts.CompilerOptions {
    // Browser-friendly defaults; callers can override via config.compilerOptions.
    return {
        noEmit: true,
        emitDecoratorMetadata: true,
        experimentalDecorators: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        strictNullChecks: false,
        skipLibCheck: true,
        skipDefaultLibCheck: true,
        esModuleInterop: true,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
}

function getAllFiles(config: CompletedConfig): FileMap {
    const lib = config.lib ?? {};
    const files = config.files ?? {};
    return { ...lib, ...files };
}

export function createProgram(config: CompletedConfig): ts.Program {
    const allFiles = getAllFiles(config);
    // Important: distinguish between `rootNames` omitted vs explicitly provided as `[]`.
    // If omitted, default to all provided source files. If explicitly `[]`, treat as "no roots".
    const rootNames = (config.rootNames !== undefined ? config.rootNames : Object.keys(config.files ?? {})).map(
        normalizeFileName,
    );

    if (!rootNames.length) {
        throw new BuildError({
            messageText:
                "No input files. In browser mode, provide `config.files` (and optionally `config.rootNames`) or pass an existing `config.tsProgram`.",
        });
    }

    const options: ts.CompilerOptions = { ...getDefaultCompilerOptions(), ...(config.compilerOptions ?? {}) };
    const host = createInMemoryCompilerHost(allFiles, options);

    const program = ts.createProgram(rootNames, options, host);

    // If `noLib` is enabled, the program intentionally does not include the default TS lib declarations.
    // In that mode, TypeScript will typically emit diagnostics like "Cannot find global type 'Array'".
    // Since many consumers use `noLib` specifically to avoid shipping lib .d.ts files in browser/VFS mode,
    // we automatically skip the typecheck gate here (schema generation can still succeed).
    const shouldTypeCheck = !config.skipTypeCheck && !options.noLib;

    if (shouldTypeCheck) {
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.length) {
            throw new BuildError({
                messageText:
                    "Type check error",
                relatedInformation: [...diagnostics],
            });
        }
    }

    return program;
}
