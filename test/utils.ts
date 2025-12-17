import type { Options as AjvOptions } from "ajv";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import type { TestFn } from "node:test";
import stringify from "safe-stable-stringify";
import ts from "typescript";
import type { FormatterAugmentor } from "../factory/formatter.js";
import { createFormatter } from "../factory/formatter.js";
import { createGenerator } from "../factory/generator.js";
import type { ParserAugmentor } from "../factory/parser.js";
import { createParser } from "../factory/parser.js";
import { createProgram } from "../factory/program.js";
import type { CompletedConfig, Config } from "../src/Config.js";
import { DEFAULT_CONFIG } from "../src/Config.js";
import { BaseError } from "../src/Error/BaseError.js";
import { SchemaGenerator } from "../src/SchemaGenerator.js";

function t<T>(fn: () => T): [true, undefined, T] | [false, unknown, undefined] {
    try {
        return [true, undefined, fn()];
    } catch (error) {
        return [false, error, undefined];
    }
}

const validator = new Ajv({ discriminator: true });
addFormats(validator);

const baseValidPath = "test/valid-data";
const baseConfigPath = "test/config";
const baseInvalidPath = "test/invalid-data";

let cachedTsLib: Record<string, string> | undefined;
function loadTypeScriptLibFiles(): Record<string, string> {
    if (cachedTsLib) return cachedTsLib;

    const libDir = path.dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }));
    const entries = fs.readdirSync(libDir);
    const libFiles = entries.filter((f) => f === "lib.d.ts" || /^lib\..*\.d\.ts$/.test(f));

    const lib: Record<string, string> = {};
    for (const fileName of libFiles) {
        lib[fileName] = fs.readFileSync(path.join(libDir, fileName), "utf8");
    }

    cachedTsLib = lib;
    return lib;
}

function expandSimpleGlob(globPattern: string): string[] {
    // Supports the patterns used by this repo's tests, e.g. "/abs/path/*.ts" or "/abs/path/main.ts".
    // Does not support "**" or character classes.
    if (globPattern.includes("**")) {
        throw new Error(`Unsupported glob pattern (**) in tests: ${globPattern}`);
    }

    const normalized = globPattern.replace(/\\/g, "/");
    if (!normalized.includes("*")) {
        return [normalized];
    }

    const dir = path.dirname(normalized);
    const base = path.basename(normalized);
    const re = new RegExp("^" + base.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

    return fs
        .readdirSync(dir)
        .filter((name) => re.test(name))
        .map((name) => path.join(dir, name).replace(/\\/g, "/"));
}

function loadFiles(fileNames: string[]): Record<string, string> {
    const files: Record<string, string> = {};
    for (const fileName of fileNames) {
        const normalized = fileName.replace(/\\/g, "/");
        files[normalized] = fs.readFileSync(fileName, "utf8");
    }
    return files;
}

function loadFromGlob(globPattern: string): { rootNames: string[]; files: Record<string, string> } {
    const rootNames = expandSimpleGlob(globPattern);
    return { rootNames, files: loadFiles(rootNames) };
}

function loadFromTsconfig(tsconfigPath: string): { rootNames: string[]; files: Record<string, string>; options: ts.CompilerOptions } {
    const configFile = ts.readConfigFile(tsconfigPath, (p) => fs.readFileSync(p, "utf8"));
    if (configFile.error) {
        throw configFile.error;
    }

    const basePath = path.dirname(tsconfigPath);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, basePath);
    const rootNames = parsed.fileNames.map((p) => p.replace(/\\/g, "/"));
    return { rootNames, files: loadFiles(rootNames), options: parsed.options };
}

export function assertConfigSchema(
    name: string,
    userConfig: Config & { type: string | string[] },
    tsconfig?: boolean,
    formatterAugmentor?: FormatterAugmentor,
    parserAugmentor?: ParserAugmentor,
): TestFn {
    return async () => {
        const config: CompletedConfig = {
            ...DEFAULT_CONFIG,
            ...userConfig,
            skipTypeCheck: !!process.env.FAST_TEST,
        };
        if (tsconfig) {
            const tsconfigPath = path.resolve(baseConfigPath, name, "tsconfig.json");
            const loaded = loadFromTsconfig(tsconfigPath);
            config.files = loaded.files;
            config.rootNames = loaded.rootNames;
            config.compilerOptions = loaded.options;
        } else {
            const loaded = loadFromGlob(path.resolve(baseConfigPath, name, "*.ts"));
            config.files = loaded.files;
            config.rootNames = loaded.rootNames;
        }

        config.lib = loadTypeScriptLibFiles();

        const program: ts.Program = createProgram(config);

        const [ok, error, generator] = t(
            () =>
                new SchemaGenerator(
                    program,
                    createParser(program, config, parserAugmentor),
                    createFormatter(config, formatterAugmentor),
                    config,
                ),
        );

        if (!ok) {
            if (error instanceof BaseError) {
                console.error(error.format(true));
            }

            throw error;
        }

        const schema = generator.createSchema(config.type);
        const schemaFile = path.resolve(baseConfigPath, name, "schema.json");

        if (process.env.UPDATE_SCHEMA) {
            await fs.promises.writeFile(schemaFile, stringify(schema, null, 2) + "\n", "utf8");
        }

        const expected: any = JSON.parse(await fs.promises.readFile(schemaFile, "utf8"));
        const actual: any = JSON.parse(JSON.stringify(schema));

        assert.equal(typeof actual, "object");
        assert.deepStrictEqual(actual, expected);

        const keywords: string[] = [];
        if (config.markdownDescription) keywords.push("markdownDescription");
        if (config.fullDescription) keywords.push("fullDescription");

        const localValidator = new Ajv({
            // skip full check if we are not encoding refs
            validateFormats: config.encodeRefs === false ? undefined : true,
            keywords: keywords.length ? keywords : undefined,
        });

        addFormats(localValidator);

        localValidator.validateSchema(actual);
        assert.equal(localValidator.errors, null);

        localValidator.compile(actual); // Will find MissingRef errors
    };
}

export function assertInvalidSchema(name: string, type: string | string[], message: string) {
    return () => {
        const config: CompletedConfig = {
            ...DEFAULT_CONFIG,
            type: type,
            expose: "export",
            topRef: true,
            jsDoc: "basic",
            skipTypeCheck: !!process.env.FAST_TEST,
        };

        const loaded = loadFromGlob(path.resolve(baseInvalidPath, name, `*.ts`));
        config.files = loaded.files;
        config.rootNames = loaded.rootNames;
        config.lib = loadTypeScriptLibFiles();

        const program: ts.Program = createProgram(config);

        const [ok, error, generator] = t(
            () => new SchemaGenerator(program, createParser(program, config), createFormatter(config)),
        );

        if (!ok) {
            if (error instanceof BaseError) {
                console.error(error.format(true));
            }

            throw error;
        }

        assert.throws(() => generator.createSchema(type), { message });
    };
}

export function assertValidSchema(
    relativePath: string,
    type?: Config["type"],
    config_?: Omit<Config, "type">,
    options?: {
        /**
         * Array of sample data
         * that should
         * successfully validate.
         */
        validSamples?: any[];
        /**
         * Array of sample data
         * that should
         * fail to validate.
         */
        invalidSamples?: any[];
        /**
         * Options to pass to Ajv
         * when creating the Ajv
         * instance.
         *
         * @default {strict:false}
         */
        ajvOptions?: AjvOptions;
        mainTsOnly?: boolean;
    },
): TestFn {
    return async () => {
        const config: CompletedConfig = {
            ...DEFAULT_CONFIG,
            skipTypeCheck: !!process.env.FAST_TEST,
            type,
            ...config_,
        };

        const loaded = loadFromGlob(path.resolve(baseValidPath, relativePath, `${options?.mainTsOnly ? "main" : "*"}.ts`));
        config.files = loaded.files;
        config.rootNames = loaded.rootNames;
        config.lib = loadTypeScriptLibFiles();

        const [ok, error, generator] = t(() => createGenerator(config));

        if (!ok) {
            if (error instanceof BaseError) {
                console.error(error.format(true));
            }

            throw error;
        }

        const schema = generator.createSchema(config.type);
        const schemaFile = path.resolve(baseValidPath, relativePath, "schema.json");

        if (process.env.UPDATE_SCHEMA) {
            await fs.promises.writeFile(schemaFile, stringify(schema, null, 2) + "\n", "utf8");
        }

        const expected: any = JSON.parse(await fs.promises.readFile(schemaFile, "utf8"));
        const actual: any = JSON.parse(JSON.stringify(schema));

        assert.equal(typeof actual, "object");
        assert.deepStrictEqual(actual, expected);

        let localValidator = validator;
        if (config.extraTags) {
            localValidator = new Ajv(options?.ajvOptions || { strict: false });
            addFormats(localValidator);
        }

        localValidator.validateSchema(actual);
        assert.equal(localValidator.errors, null);

        // Compile in all cases to detect MissingRef errors
        const validate = localValidator.compile(actual);

        // Use the compiled validator if there
        // are any samples.
        if (options?.invalidSamples) {
            for (const sample of options.invalidSamples) {
                const isValid = validate(sample);

                if (isValid) {
                    console.log("Unexpectedly Valid:", sample);
                }

                assert.equal(isValid, false);
            }
        }

        if (options?.validSamples) {
            for (const sample of options.validSamples) {
                const isValid = validate(sample);

                if (!isValid) {
                    console.log("Unexpectedly Invalid:", sample);
                    console.log("AJV Errors:", validate.errors);
                }

                assert.equal(isValid, true);
            }
        }
    };
}
