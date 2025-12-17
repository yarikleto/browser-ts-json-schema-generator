import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { it } from "node:test";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import ts from "typescript";
import { createGenerator } from "../../factory/generator.js";
import { createProgram } from "../../factory/program.js";
import { DEFAULT_CONFIG } from "../../src/Config.js";

function loadTypeScriptLibFiles(): Record<string, string> {
    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
    const entries = fs.readdirSync(libDir);
    const libFiles = entries.filter((f) => f === "lib.d.ts" || /^lib\..*\.d\.ts$/.test(f));

    const lib: Record<string, string> = {};
    for (const fileName of libFiles) {
        lib[fileName] = fs.readFileSync(path.join(libDir, fileName), "utf8");
    }
    return lib;
}

it("can typecheck code using standard lib types when TS lib .d.ts files are provided (skipLibCheck=false)", () => {
    const fileName = "/main.ts";
    const files: Record<string, string> = {
        [fileName]: `
            export interface LibType {
            promise: Promise<number>;
            map: Map<string, Set<number>>;
            bytes: Uint8Array;
            big: bigint;
            date: Date;
            }
        `,
    };

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        lib: loadTypeScriptLibFiles(),
        compilerOptions: {
            skipLibCheck: false,
            skipDefaultLibCheck: false,
        },
    };

    const program = createProgram(completedConfig);
    const diagnostics = ts.getPreEmitDiagnostics(program);

    assert.deepStrictEqual(
        diagnostics,
        [],
        `Expected 0 diagnostics, got:\n${ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCanonicalFileName: (f) => f,
            getCurrentDirectory: () => "/",
            getNewLine: () => "\n",
        })}`,
    );
});

it("when multiple lib files are provided, prefers TypeScript default lib name if present", () => {
    const fileName = "/main.ts";
    const files: Record<string, string> = {
        [fileName]: `
export interface NeedsLib {
  promise: Promise<number>;
  map: Map<string, Set<number>>;
  date: Date;
}
`,
    };

    const tsDefaultLibName = ts.getDefaultLibFileName({ target: ts.ScriptTarget.ES2022 });

    const minimalLib = `
// Minimal "baseline" globals TypeScript expects when noLib=false.
type PropertyKey = string | number | symbol;
interface Object {}
interface Function {}
interface IArguments {}
interface ArrayLike<T> { length: number; [n: number]: T; }
interface Array<T> extends ArrayLike<T> {}
interface ReadonlyArray<T> extends ArrayLike<T> {}
interface String {}
interface Number {}
interface Boolean {}
interface RegExp {}

// The specific lib types this test uses.
declare interface Promise<T> {}
declare interface Map<K, V> {}
declare interface Set<T> {}
declare class Date {}
`.trim();

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        lib: {
            // Intentionally "bad" lib.d.ts – if the host picked this as default, we'd get missing Promise/Map/etc.
            "lib.d.ts": "",
            // Provide TS's default lib file name for the chosen target; host should prefer this key when present.
            [tsDefaultLibName]: minimalLib,
        },
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            skipLibCheck: false,
            skipDefaultLibCheck: false,
        },
    };

    const program = createProgram(completedConfig as any);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepStrictEqual(diagnostics, [], "Expected 0 diagnostics when TS-default lib file is present");

    const sourceFiles = program.getSourceFiles().map((sf) => sf.fileName);
    assert.ok(sourceFiles.includes(tsDefaultLibName), `Expected program to load "${tsDefaultLibName}" as default lib`);
    assert.ok(!sourceFiles.includes("lib.d.ts"), `Did not expect program to load "lib.d.ts" as default lib`);
});

it("throws when lib is empty but code uses standard lib types (ensures we don't fall back to filesystem libs)", () => {
    const fileName = "/main.ts";
    const files: Record<string, string> = {
        [fileName]: `
            export interface NeedsLib {
              promise: Promise<number>;
            }
        `,
    };

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        lib: {}, // user provided lib map, but it's empty
        compilerOptions: {
            // default in createProgram is noLib=false, but since we are in browser/VFS mode there is no filesystem fallback.
            // If the user doesn't provide lib sources, TypeScript should error (and createProgram will throw).
            skipLibCheck: false,
            skipDefaultLibCheck: false,
        },
    };

    assert.throws(
        () => createProgram(completedConfig as any),
        (err: any) => {
            if (typeof err?.message !== "string" || !err.message.includes("Type check error")) return false;
            const related: any[] | undefined = err?.diagnostic?.relatedInformation;
            const relatedMessages =
                Array.isArray(related) ? related.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) : [];
            const haystack = relatedMessages.join("\n");

            // Be flexible about the exact TS diagnostic(s), but ensure we see missing lib/global type signals.
            return (
                haystack.includes("Cannot find global type") ||
                haystack.includes("Cannot find name 'Promise'") ||
                haystack.includes("Cannot find name 'Map'") ||
                haystack.includes("Cannot find name 'Set'")
            );
        },
    );
});

it("uses provided in-memory lib sources: empty default lib file causes missing global types diagnostics", () => {
    const fileName = "/main.ts";
    const files: Record<string, string> = {
        [fileName]: `
            export interface NeedsLib {
              promise: Promise<number>;
              map: Map<string, Set<number>>;
            }
        `,
    };

    const defaultLibName = ts.getDefaultLibFileName({ target: ts.ScriptTarget.ES2022 });

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        // Provide the expected default lib file, but with empty contents: TypeScript should *not* magically find Promise/Map.
        lib: { [defaultLibName]: "" },
        compilerOptions: {
            skipLibCheck: false,
            skipDefaultLibCheck: false,
        },
    };

    const [ok, err] = (() => {
        try {
            createProgram(completedConfig as any);
            return [true, undefined] as const;
        } catch (e) {
            return [false, e] as const;
        }
    })();

    assert.equal(ok, false, "Expected createProgram to throw due to missing global lib types");
    const related: any[] | undefined = (err as any)?.diagnostic?.relatedInformation;
    const relatedMessages =
        Array.isArray(related) ? related.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) : [];

    const fallback = String((err as any)?.message ?? err);
    const haystack = relatedMessages.length ? relatedMessages.join("\n") : fallback;

    assert.ok(haystack.includes("Cannot find name 'Promise'"), `Expected missing Promise, got:\n${haystack}`);
    assert.ok(haystack.includes("Cannot find name 'Map'"), `Expected missing Map, got:\n${haystack}`);
});

it("can generate schema for a type that uses standard lib types when TS lib .d.ts files are provided", () => {
    const fileName = "/main.ts";
    const files: Record<string, string> = {
        [fileName]: `
            export interface LibTypeForSchema {
            promise: Promise<number>;
            map: Map<string, Set<number>>;
            bytes: Uint8Array;
            big: bigint;
            date: Date;
        }
        `,
    };

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        lib: loadTypeScriptLibFiles(),
        compilerOptions: {
            // Keep defaults, but ensure we aren't relying on `noLib`.
            skipLibCheck: true,
            skipDefaultLibCheck: true,
        },
    };

    const program = createProgram(completedConfig);
    const generator = createGenerator({ tsProgram: program, type: "LibTypeForSchema" });
    const schema = generator.createSchema("LibTypeForSchema");

    // Strictly validate the shape we expect at the top level.
    assert.equal(schema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.equal(schema.$ref, "#/definitions/LibTypeForSchema");
    assert.equal(typeof schema.definitions, "object");
    assert.ok(schema.definitions?.LibTypeForSchema, "Expected schema.definitions.LibTypeForSchema to be present");

    const def: any = (schema.definitions as any).LibTypeForSchema;
    assert.equal(def.type, "object");
    assert.equal(def.additionalProperties, false);
    assert.deepStrictEqual(def.required?.sort(), ["big", "bytes", "date", "map", "promise"].sort());
    assert.equal(typeof def.properties, "object");
    assert.ok(def.properties.promise);
    assert.ok(def.properties.map);
    assert.ok(def.properties.bytes);
    assert.ok(def.properties.big);
    assert.ok(def.properties.date);

    // Strictly validate the entire schema and ensure all $ref are resolvable.
    const ajv = new Ajv({ strict: true });
    addFormats(ajv);
    const isValidSchema = ajv.validateSchema(schema as any);
    assert.equal(isValidSchema, true, `Schema is invalid: ${ajv.errorsText(ajv.errors, { separator: "\n" })}`);
    assert.doesNotThrow(() => ajv.compile(schema as any), "Schema has unresolved $ref or other compile-time issues");
});


