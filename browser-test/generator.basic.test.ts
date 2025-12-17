import { createGenerator } from "../factory/generator.js";

describe("browser generator (in-memory)", () => {
    it("generates schema for a simple exported interface (noLib)", () => {
        const schema = createGenerator({
            type: "MyType",
            files: {
                "/main.ts": `
                    /** MyType docs */
                    export interface MyType {
                      /** a docs */
                      a: string;
                      b?: number;
                    }
                `,
            },
            rootNames: ["/main.ts"],
            compilerOptions: { noLib: true },
        }).createSchema("MyType");

        const def: any = schema.definitions?.MyType;
        expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
        expect(schema.$ref).toBe("#/definitions/MyType");
        expect(def.type).toBe("object");
        expect(def.additionalProperties).toBe(false);
        expect(def.properties?.a).toEqual({ type: "string", description: "a docs" });
        expect(def.properties?.b).toEqual({ type: "number" });
        expect(def.required).toEqual(["a"]);
        expect(def.description).toBe("MyType docs");
    });

    it("supports literal unions (noLib)", () => {
        const schema = createGenerator({
            type: "U",
            files: {
                "/main.ts": `
                    export type U = "a" | "b";
                `,
            },
            rootNames: ["/main.ts"],
            compilerOptions: { noLib: true },
        }).createSchema("U");

        const u: any = schema.definitions?.U;
        // Depending on formatter behavior, this may become { enum: [...] } or { anyOf: [...] }.
        if (u?.enum) {
            expect(u.enum).toEqual(["a", "b"]);
        } else {
            expect(u?.anyOf?.map((x: any) => x.const)).toEqual(["a", "b"]);
        }
    });

    it("generates schema for a type using standard lib types when lib .d.ts files are provided", () => {
        // In browser/VFS mode, the caller must provide TypeScript lib .d.ts sources in-memory.
        // Use a tiny synthetic lib here (no filesystem) to prove the generator actually consumes `config.lib`.
        const fakeLib = `
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

        const schema = createGenerator({
            type: "LibType",
            files: {
                "/main.ts": `
                    export interface LibType {
                      promise: Promise<number>;
                      map: Map<string, Set<number>>;
                      date: Date;
                    }
                `,
            },
            rootNames: ["/main.ts"],
            lib: { "lib.d.ts": fakeLib },
        }).createSchema("LibType");

        const def: any = schema.definitions?.LibType;
        expect(schema.$ref).toBe("#/definitions/LibType");
        expect(def?.type).toBe("object");
        expect(def?.properties?.promise).toBeDefined();
        expect(def?.properties?.map).toBeDefined();
        expect(def?.properties?.date).toBeDefined();
    });
});


