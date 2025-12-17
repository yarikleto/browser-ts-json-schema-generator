import { createGenerator } from "../factory/generator.js";

describe("browser generator (in-memory)", () => {
    it("generates schema for a simple exported interface (noLib)", () => {
        const schema = createGenerator({
            type: "MyType",
            skipTypeCheck: true,
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
            skipTypeCheck: true,
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
});


