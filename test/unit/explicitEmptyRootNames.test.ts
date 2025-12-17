import { test } from "node:test";
import assert from "node:assert";
import { createGenerator } from "../../factory/generator.js";

test("explicit empty rootNames does not fall back to Object.keys(files)", () => {
    assert.throws(
        () =>
            createGenerator({
                type: "MyType",
                files: {
                    "/main.ts": `export interface MyType { a: string }`,
                },
                rootNames: [],
                compilerOptions: { noLib: true },
                skipTypeCheck: true,
            }).createSchema("MyType"),
        (err: any) => {
            return typeof err?.message === "string" && err.message.includes("No input files");
        },
    );
});


