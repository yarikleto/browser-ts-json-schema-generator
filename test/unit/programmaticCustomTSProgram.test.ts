import assert from "node:assert";
import { it } from "node:test";
import ts from "typescript";
import { createGenerator } from "../../factory/generator";
import type { Config } from "../../src/Config";

it("Can generate a schema from a vfs", () => {
    const tsInterface = `
    /**
     * This is a sample interface
     */
    export interface SampleInterface {
        /** This is a name */
        name: string;
    }
    `;

    const fileName = "/schema.ts";
    const host: ts.CompilerHost = {
        fileExists: (name) => name === fileName,
        readFile: (name) => (name === fileName ? tsInterface : undefined),
        getSourceFile: (name, languageVersion) => {
            if (name !== fileName) return undefined;
            return ts.createSourceFile(name, tsInterface, languageVersion, true);
        },
        getDefaultLibFileName: () => "lib.d.ts",
        writeFile: () => {
            /* no-op */
        },
        getCurrentDirectory: () => "/",
        getDirectories: () => [],
        directoryExists: () => true,
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
    };

    const program = ts.createProgram(
        [fileName],
        {
            noLib: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
        },
        host,
    );

    const schemaConfig: Config = { path: fileName, tsProgram: program };
    const generator = createGenerator(schemaConfig);

    const result = generator.createSchema();
    assert.deepStrictEqual(result, {
        $ref: "#/definitions/SampleInterface",
        $schema: "http://json-schema.org/draft-07/schema#",
        definitions: {
            SampleInterface: {
                additionalProperties: false,
                description: "This is a sample interface",
                properties: {
                    name: {
                        description: "This is a name",
                        type: "string",
                    },
                },
                required: ["name"],
                type: "object",
            },
        },
    });
});
