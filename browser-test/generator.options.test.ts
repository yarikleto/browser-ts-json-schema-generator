import { createGenerator } from "../factory/generator.js";

describe("browser generator options", () => {
    it("can generate schema for all exported types with type='*' (noLib)", () => {
        const schema = createGenerator({
            type: "*",
            skipTypeCheck: true,
            files: {
                "/main.ts": `
                    export interface A { a: string }
                    export interface B { b: number }
                `,
            },
            rootNames: ["/main.ts"],
            compilerOptions: { noLib: true },
        }).createSchema("*");

        expect((schema.definitions?.A as any)?.type).toBe("object");
        expect((schema.definitions?.B as any)?.type).toBe("object");
    });
});


