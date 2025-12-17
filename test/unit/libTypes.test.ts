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
            // default in createProgram is noLib=false, so a default lib file is required in browser mode
            skipLibCheck: false,
            skipDefaultLibCheck: false,
        },
    };

    const defaultLibName = ts.getDefaultLibFileName({ target: ts.ScriptTarget.ES2022 });

    assert.throws(
        () => createProgram(completedConfig as any),
        (err: any) =>
            typeof err?.message === "string" &&
            err.message.includes("Missing TypeScript lib file") &&
            err.message.includes(defaultLibName),
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


