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

    const host: ts.CompilerHost = {
        fileExists: (fileName: string) => getText(fileName) !== undefined,
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
        getDefaultLibFileName: (opts: ts.CompilerOptions) => ts.getDefaultLibFileName(opts),
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
    const rootNames = (config.rootNames?.length ? config.rootNames : Object.keys(config.files ?? {})).map(
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

    // Ensure the default lib is available if the user didn't opt out.
    if (!options.noLib) {
        const defaultLib = normalizeFileName(host.getDefaultLibFileName(options));
        if (!host.fileExists(defaultLib)) {
            throw new BuildError({
                messageText:
                    `Missing TypeScript lib file "${defaultLib}". In browser mode, pass lib .d.ts contents via ` +
                    "`config.lib` (e.g. { [\"/lib.es2022.d.ts\"]: \"...\" }) or set `compilerOptions.noLib = true`.",
            });
        }
    }

    const program = ts.createProgram(rootNames, options, host);

    if (!config.skipTypeCheck) {
        const diagnostics = ts.getPreEmitDiagnostics(program);
        if (diagnostics.length) {
            throw new BuildError({
                messageText:
                    "Type check error. In browser mode, either provide TypeScript lib `.d.ts` files via `config.lib`, or set `skipTypeCheck: true` (especially when using `compilerOptions.noLib: true`).",
                relatedInformation: [...diagnostics],
            });
        }
    }

    return program;
}

