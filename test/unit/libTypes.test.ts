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

it("expands utility type ReturnType<typeof fn> to the actual return object schema", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function transform(input: string): { id: number, name: string } {
  return { id: 1, name: "test" };
}

export type TransformResult = ReturnType<typeof transform>;
`,
    };

    // ES5-only setup (matches README guidance)
    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "TransformResult" });
    const schema = generator.createSchema("TransformResult");

    const def: any = schema.definitions?.TransformResult;
    assert.equal(schema.$ref, "#/definitions/TransformResult");
    assert.equal(def?.type, "object");
    assert.equal(def?.additionalProperties, false);
    assert.deepStrictEqual(def?.required?.sort(), ["id", "name"]);
    assert.deepStrictEqual(def?.properties?.id, { type: "number" });
    assert.deepStrictEqual(def?.properties?.name, { type: "string" });
});

it("expands utility type ReturnType<typeof genericFn<T>> when instantiated (ReturnType<typeof fn<T>>)", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function transform<T extends string>(input: T): T {
  return input;
}

export type TransformResult<T extends string> = ReturnType<typeof transform<T>>;

const a: TransformResult<string> = transform("test");
export type Kek = typeof a;
`,
    };

    // ES5-only setup (matches README guidance)
    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Kek" });
    const schema = generator.createSchema("Kek");

    assert.equal(schema.$ref, "#/definitions/Kek");
    assert.deepStrictEqual(schema.definitions?.["TransformResult<string>"], { type: "string" });
});

it("reduces ReturnType<typeof fn<literal>> to a literal schema", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function id<T extends string>(x: T): T {
  return x;
}

export type Out = ReturnType<typeof id<"x">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const def: any = schema.definitions?.Out;
    // Out may be a direct literal schema or a $ref to an instantiated alias; accept both shapes.
    if (def?.$ref) {
        const name = decodeURIComponent(String(def.$ref).replace("#/definitions/", ""));
        assert.deepStrictEqual((schema.definitions as any)[name], { type: "string", const: "x" });
    } else {
        assert.deepStrictEqual(def, { type: "string", const: "x" });
    }
});

it("reduces Parameters<typeof fn<...>> when the generic is instantiated", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function f<T extends string>(x: T, y: number): { x: T; y: number } {
  return { x, y };
}

export type Args = Parameters<typeof f<"k">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Args" });
    const schema = generator.createSchema("Args");

    const args: any = schema.definitions?.Args;
    assert.ok(args && typeof args === "object");

    const resolved = args.$ref ? (schema.definitions as any)[decodeURIComponent(args.$ref.replace("#/definitions/", ""))] : args;
    assert.deepStrictEqual(resolved, {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [
            { type: "string", const: "k", title: "x" },
            { type: "number", title: "y" },
        ],
    });
});

it("supports partially-instantiated generics inside typeof: ReturnType<typeof pair<string, U>>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function pair<T, U>(a: T, b: U): [T, U] {
  return [a, b];
}

export type P<U> = ReturnType<typeof pair<string, U>>;
export type Out = P<number>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    assert.ok(out && typeof out === "object");
    const resolved = out.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;
    assert.deepStrictEqual(resolved, {
        type: "array",
        minItems: 2,
        maxItems: 2,
        // Note: tuple item titles are not guaranteed here (they are typically added for Parameters<>),
        // so we assert only the structural tuple types.
        items: [{ type: "string" }, { type: "number" }],
    });
});

it("supports aliasing typeof fn<T> and applying utility types to the alias", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function transform<T extends string>(input: T): T {
  return input;
}

export type Fn<T extends string> = typeof transform<T>;
export type Out = ReturnType<Fn<"a">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const def: any = schema.definitions?.Out;
    const resolved = def?.$ref ? (schema.definitions as any)[decodeURIComponent(def.$ref.replace("#/definitions/", ""))] : def;
    assert.deepStrictEqual(resolved, { type: "string", const: "a" });
});

it("reduces custom infer-based generic aliases when the input comes from ReturnType<typeof fn<...>>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
// Minimal local PromiseLike so we don't rely on ES2015 lib in this ES5 test setup.
export interface PromiseLike<T> { then(onfulfilled: (value: T) => any): any; }

export function g<T>(x: T): PromiseLike<T> {
  return { then: (_f) => undefined } as any;
}

export type Unbox<T> = T extends PromiseLike<infer U> ? U : never;
export type Out = Unbox<ReturnType<typeof g<number>>>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;
    assert.deepStrictEqual(resolved, { type: "number" });
});

it("supports deeply nested generic alias chains that ultimately depend on typeof fn<T> instantiation", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function id<T extends string>(x: T): T {
  return x;
}

export type A<T extends string> = ReturnType<typeof id<T>>;
export type B<T extends string> = A<T>;
export type C<T extends string> = B<T>;
export type Out = C<"z">;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        // Follow $ref chains (can happen with nested generic aliases).
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) {
                throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            }
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };
    assert.deepStrictEqual(resolve(out), { type: "string", const: "z" });
});

it("supports mapped types over instantiated generics (ReturnType<typeof fn<...>> where fn returns a mapped type)", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function mk<T extends "a" | "b">(k: T): { [K in T]: number } {
  return { [k]: 1 } as any;
}

export type Out = ReturnType<typeof mk<"a" | "b">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;
    assert.deepStrictEqual(resolved, {
        type: "object",
        properties: {
            a: { type: "number" },
            b: { type: "number" },
        },
        required: ["a", "b"],
        additionalProperties: false,
    });
});

it("reduces nested instantiations to literal tuples (ReturnType<typeof dup<literal>>)", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function dup<T extends string>(x: T): [T, T] {
  return [x, x];
}
export type Out = ReturnType<typeof dup<"x">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;
    // Depending on formatter behavior, this tuple may be encoded as:
    // - a true tuple: items: [A, A]
    // - a homogenous array with fixed length: items: A, minItems/maxItems: 2
    const expectedItem = { type: "string", const: "x" };
    assert.equal(resolved?.type, "array");
    assert.equal(resolved?.minItems, 2);
    assert.equal(resolved?.maxItems, 2);
    if (Array.isArray(resolved?.items)) {
        assert.deepStrictEqual(resolved.items, [expectedItem, expectedItem]);
    } else {
        assert.deepStrictEqual(resolved?.items, expectedItem);
    }
});

it("handles overloads with generic instantiation in typeof: ReturnType<typeof fn<T>> picks the generic overload", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function ov(x: number): number;
export function ov<T extends string>(x: T): T;
export function ov(x: any) { return x; }

export type Out = ReturnType<typeof ov<"x">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;

    // We expect the instantiated generic overload (T="x") to be selected, resulting in a string-literal schema.
    assert.deepStrictEqual(resolved, { type: "string", const: "x" });
});

it("supports InstanceType<typeof Class<T>> and ConstructorParameters<typeof Class<T>> with instantiated generics", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export class Box<T extends string> {
  constructor(public value: T, public n: number) {}
}

export type Inst = InstanceType<typeof Box<"a">>;
export type Ctor = ConstructorParameters<typeof Box<"a">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: ["Inst", "Ctor"] }).createSchema(["Inst", "Ctor"]);

    // Inst should resolve to the class instance shape with value literal "a"
    const inst: any = schema.definitions?.Inst;
    const instResolved = inst?.$ref
        ? (schema.definitions as any)[decodeURIComponent(inst.$ref.replace("#/definitions/", ""))]
        : inst;
    assert.deepStrictEqual(instResolved, {
        type: "object",
        properties: {
            value: { type: "string", const: "a" },
            n: { type: "number" },
        },
        required: ["value", "n"],
        additionalProperties: false,
    });

    // Ctor should resolve to a tuple [ "a", number ]
    const ctor: any = schema.definitions?.Ctor;
    const ctorResolved = ctor?.$ref
        ? (schema.definitions as any)[decodeURIComponent(ctor.$ref.replace("#/definitions/", ""))]
        : ctor;
    assert.equal(ctorResolved?.type, "array");
    assert.equal(ctorResolved?.minItems, 2);
    assert.equal(ctorResolved?.maxItems, 2);
    assert.ok(ctorResolved?.items, "Expected tuple items to be present");
    if (Array.isArray(ctorResolved.items)) {
        assert.deepStrictEqual(ctorResolved.items, [
            { type: "string", const: "a", title: "value" },
            { type: "number", title: "n" },
        ]);
    } else {
        // Accept homogenous encoding as long as min/max items are fixed.
        assert.deepStrictEqual(ctorResolved.items, { type: "string" });
    }
});

it("supports template literal types through instantiated typeof: ReturnType<typeof fn<...>>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function fmt<T extends string>(x: T): \`id-\${T}\` {
  return ("id-" + x) as any;
}

export type Out = ReturnType<typeof fmt<"a" | "b">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;

    // Template literal unions should reduce to enum-like schemas. Formatter may choose `enum` or `anyOf` consts.
    if (Array.isArray(resolved?.enum)) {
        assert.deepStrictEqual(resolved.enum.sort(), ["id-a", "id-b"]);
    } else if (Array.isArray(resolved?.anyOf)) {
        assert.deepStrictEqual(
            resolved.anyOf.map((x: any) => x.const).sort(),
            ["id-a", "id-b"],
        );
    } else {
        assert.fail(`Unexpected schema for template-literal union: ${JSON.stringify(resolved)}`);
    }
});

it("supports variadic tuples through instantiated typeof: ReturnType<typeof fn<...>>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function pack<T extends any[]>(...args: T): T {
  return args as any;
}

export type Out = ReturnType<typeof pack<[1, "a", true]>>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Out" });
    const schema = generator.createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;

    // We accept either strict tuple encoding or a fixed-length homogeneous encoding, but we should at least preserve length 3.
    assert.equal(resolved?.type, "array");
    assert.equal(resolved?.minItems, 3);
    assert.equal(resolved?.maxItems, 3);
});

it("supports qualified names in instantiated type queries: ReturnType<typeof NS.fn<T>>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export namespace NS {
  export function f<T extends string>(x: T): T {
    return x;
  }
}

export type Out = ReturnType<typeof NS.f<"x">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: "Out" }).createSchema("Out");

    const out: any = schema.definitions?.Out;
    const resolved = out?.$ref ? (schema.definitions as any)[decodeURIComponent(out.$ref.replace("#/definitions/", ""))] : out;
    assert.deepStrictEqual(resolved, { type: "string", const: "x" });
});

it("supports ThisParameterType / OmitThisParameter / ReturnType on instantiated typeof fn<T>", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function method<T extends string>(this: { ctx: T }, x: number): T {
  return this.ctx;
}

export type Ctx = ThisParameterType<typeof method<"a">>;
export type Res = ReturnType<OmitThisParameter<typeof method<"a">>>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: ["Ctx", "Res"] }).createSchema(["Ctx", "Res"]);

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) {
                throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            }
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    assert.deepStrictEqual(resolve(schema.definitions?.Ctx), {
        type: "object",
        properties: { ctx: { type: "string", const: "a" } },
        required: ["ctx"],
        additionalProperties: false,
    });
    assert.deepStrictEqual(resolve(schema.definitions?.Res), { type: "string", const: "a" });
});

it("supports distributive conditional types fed by instantiated generics", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function id<T extends string | number>(x: T): T {
  return x;
}

export type Wrap<T> = T extends string ? { s: T } : { n: T };
export type Out = Wrap<ReturnType<typeof id<"a" | 1>>>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: "Out" }).createSchema("Out");

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) {
                throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            }
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    const out: any = resolve(schema.definitions?.Out);
    const alts: any[] = out?.anyOf ?? out?.oneOf ?? out?.allOf;
    assert.ok(Array.isArray(alts) && alts.length >= 2, `Expected a union schema, got: ${JSON.stringify(out)}`);

    const resolvedAlts = alts.map(resolve);
    const hasS = resolvedAlts.some(
        (v) => v?.type === "object" && v?.properties?.s?.const === "a" && v?.properties?.s?.type === "string",
    );
    const hasN = resolvedAlts.some(
        (v) => v?.type === "object" && v?.properties?.n?.const === 1 && v?.properties?.n?.type === "number",
    );
    assert.ok(hasS, `Expected branch { s: "a" }, got: ${JSON.stringify(out)}`);
    assert.ok(hasN, `Expected branch { n: 1 }, got: ${JSON.stringify(out)}`);
});

it("supports internal/VFS import types: import(\"./mod\").Type<T> and typeof import(\"./mod\").fn<T>", () => {
    const fileName = "/index.ts";
    const modName = "/mod.ts";
    const files: Record<string, string> = {
        [modName]: `
export type Box<T extends string> = { value: T };
export function id<T extends string>(x: T): T { return x; }
`,
        [fileName]: `
export type A = import("./mod").Box<"a">;
export type B = ReturnType<typeof import("./mod").id<"b">>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName, modName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: ["A", "B"] }).createSchema(["A", "B"]);

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) {
                throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            }
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    assert.deepStrictEqual(resolve(schema.definitions?.A), {
        type: "object",
        properties: { value: { type: "string", const: "a" } },
        required: ["value"],
        additionalProperties: false,
    });
    assert.deepStrictEqual(resolve(schema.definitions?.B), { type: "string", const: "b" });
});

it("supports keyof + indexed access over instantiated ReturnType (key unions stay precise)", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function make<T extends object>(x: T): T { return x; }

export type Obj = ReturnType<typeof make<{ a: 1; b: 2 }>>;
export type Keys = keyof Obj;
export type ValA = Obj["a"];
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: ["Keys", "ValA"] }).createSchema(["Keys", "ValA"]);

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    const keys: any = resolve(schema.definitions?.Keys);
    if (Array.isArray(keys?.enum)) {
        assert.deepStrictEqual(keys.enum.sort(), ["a", "b"]);
    } else if (Array.isArray(keys?.anyOf)) {
        assert.deepStrictEqual(
            keys.anyOf.map((x: any) => x.const).sort(),
            ["a", "b"],
        );
    } else {
        assert.fail(`Unexpected Keys schema: ${JSON.stringify(keys)}`);
    }

    assert.deepStrictEqual(resolve(schema.definitions?.ValA), { type: "number", const: 1 });
});

it("supports mapped types with key remapping (`as`) over instantiated ReturnType", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function make<T extends object>(x: T): T { return x; }
export type Obj = ReturnType<typeof make<{ a: string; b: number }>>;
export type Remap<T> = { [K in keyof T as \`x_\${string & K}\`]: T[K] };
export type Out = Remap<Obj>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: "Out" }).createSchema("Out");

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    const out: any = resolve(schema.definitions?.Out);
    assert.deepStrictEqual(out, {
        type: "object",
        properties: {
            x_a: { type: "string" },
            x_b: { type: "number" },
        },
        required: ["x_a", "x_b"],
        additionalProperties: false,
    });
});

it("supports recursive conditional generic aliases (DeepPartial) fed by instantiated ReturnType", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function make<T extends object>(x: T): T { return x; }
export type Obj = ReturnType<typeof make<{ a: { b: number }; c: string }>>;
export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;
export type Out = DeepPartial<Obj>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const schema = createGenerator({ tsProgram: program, type: "Out" }).createSchema("Out");

    const resolve = (node: any): any => {
        let cur = node;
        const seen = new Set<string>();
        let steps = 0;
        while (cur && typeof cur === "object" && cur.$ref) {
            const ref = String(cur.$ref);
            if (seen.has(ref) || steps++ > 100) throw new Error(`Infinite $ref loop while resolving: ${ref}`);
            seen.add(ref);
            const name = decodeURIComponent(ref.replace("#/definitions/", ""));
            cur = (schema.definitions as any)[name];
        }
        return cur;
    };

    const out: any = resolve(schema.definitions?.Out);
    assert.equal(out?.type, "object");
    assert.equal(out?.additionalProperties, false);
    assert.ok(out?.properties?.a, "Expected optional property a");
    assert.ok(out?.properties?.c, "Expected optional property c");
    assert.ok(!out.required || (Array.isArray(out.required) && out.required.length === 0));

    const a: any = resolve(out.properties.a);
    assert.equal(a?.type, "object");
    assert.ok(a?.properties?.b, "Expected nested optional property b");
    assert.ok(!a.required || (Array.isArray(a.required) && a.required.length === 0));
});

it("expands infer-based utility types Parameters<> and ConstructorParameters<> to tuple schemas", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function transform(input: string, flag?: boolean): { id: number, name: string } {
  return { id: 1, name: "test" };
}
export type Params = Parameters<typeof transform>;

export class C {
  constructor(x: number, y: string) {}
}
export type CtorParams = ConstructorParameters<typeof C>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: ["Params", "CtorParams"] });
    const schema = generator.createSchema(["Params", "CtorParams"]);

    const params: any = schema.definitions?.Params;
    assert.deepStrictEqual(params, {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [
            { type: "string", title: "input" },
            { type: "boolean", title: "flag" },
        ],
    });

    const ctorParams: any = schema.definitions?.CtorParams;
    assert.deepStrictEqual(ctorParams, {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [
            { type: "number", title: "x" },
            { type: "string", title: "y" },
        ],
    });
});

it("handles a complex nested combination of infer-based utility types", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
export function transform(this: { ctx: string }, input: string, flag: boolean): { id: number, name: string } {
  return { id: 1, name: "test" };
}

export type Ctx = ThisParameterType<typeof transform>;
export type Args = Parameters<OmitThisParameter<typeof transform>>;
export type Res = ReturnType<OmitThisParameter<typeof transform>>;

export type Complex = {
  ctx: Ctx;
  args: Args;
  res: Res;
};
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: "Complex" });
    const schema = generator.createSchema("Complex");

    const def: any = schema.definitions?.Complex;
    assert.equal(def?.type, "object");
    assert.equal(def?.additionalProperties, false);
    assert.deepStrictEqual(def?.required?.sort(), ["args", "ctx", "res"]);

    // The generator exposes nested types as definitions and references them from Complex.
    assert.deepStrictEqual(def?.properties?.ctx, { $ref: "#/definitions/Ctx" });
    assert.deepStrictEqual(def?.properties?.args, { $ref: "#/definitions/Args" });
    assert.deepStrictEqual(def?.properties?.res, { $ref: "#/definitions/Res" });

    // Ctx: { ctx: string }
    assert.deepStrictEqual(schema.definitions?.Ctx, {
        type: "object",
        properties: { ctx: { type: "string" } },
        required: ["ctx"],
        additionalProperties: false,
    });

    // Args: [string, boolean]
    assert.deepStrictEqual(schema.definitions?.Args, {
        type: "array",
        minItems: 2,
        maxItems: 2,
        items: [
            { type: "string", title: "input" },
            { type: "boolean", title: "flag" },
        ],
    });

    // Res: { id: number, name: string }
    assert.deepStrictEqual(schema.definitions?.Res, {
        type: "object",
        properties: { id: { type: "number" }, name: { type: "string" } },
        required: ["id", "name"],
        additionalProperties: false,
    });
});

it("supports custom conditional types using infer (non-sourceless)", () => {
    const fileName = "/index.ts";
    const files: Record<string, string> = {
        [fileName]: `
// Custom infer: extract property type
export type ExtractProp<T, K extends keyof T> = T extends Record<K, infer V> ? V : never;
export type PropOut = ExtractProp<{ a: string; b: number }, "b">;

// Custom infer: extract tuple head
export type Head<T> = T extends [infer H, ...any[]] ? H : never;
export type HeadOut = Head<[true, 1, "x"]>;
`,
    };

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES5 }));
    const libEs5 = fs.readFileSync(path.join(libDir, "lib.es5.d.ts"), "utf8");

    const completedConfig = {
        ...DEFAULT_CONFIG,
        files,
        rootNames: [fileName],
        compilerOptions: {
            target: ts.ScriptTarget.ES5,
            module: ts.ModuleKind.ESNext,
        },
        lib: { "lib.es5.d.ts": libEs5 },
    };

    const program = createProgram(completedConfig as any);
    const generator = createGenerator({ tsProgram: program, type: ["PropOut", "HeadOut"] });
    const schema = generator.createSchema(["PropOut", "HeadOut"]);

    const defNameFromRef = (ref: string): string => {
        assert.ok(ref.startsWith("#/definitions/"), `Unexpected $ref: ${ref}`);
        return decodeURIComponent(ref.slice("#/definitions/".length));
    };

    // PropOut should reduce to number (possibly via an instantiated generic alias $ref)
    const propOutDef: any = schema.definitions?.PropOut;
    assert.ok(propOutDef && typeof propOutDef === "object");
    const propOutName = defNameFromRef(propOutDef.$ref);
    assert.deepStrictEqual((schema.definitions as any)[propOutName], { type: "number" });

    // HeadOut should reduce to boolean literal true (possibly via an instantiated generic alias $ref)
    const headOutDef: any = schema.definitions?.HeadOut;
    assert.ok(headOutDef && typeof headOutDef === "object");
    const headOutName = defNameFromRef(headOutDef.$ref);
    assert.deepStrictEqual((schema.definitions as any)[headOutName], { type: "boolean", const: true });
});


