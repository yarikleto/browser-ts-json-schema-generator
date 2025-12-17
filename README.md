# @yarikleto/browser-ts-json-schema-generator

[![npm version](https://img.shields.io/npm/v/%40yarikleto%2Fbrowser-ts-json-schema-generator.svg)](https://www.npmjs.com/package/@yarikleto/browser-ts-json-schema-generator)

Based on the [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator)

Generate **JSON Schema** from TypeScript types in the **browser**.

This fork is **browser-only**:
- No Node.js CLI
- No filesystem access
- You pass TypeScript sources as **strings** (`config.files`)

### Install

```bash
npm i @yarikleto/browser-ts-json-schema-generator
```

### How it works

To build a TypeScript `Program` in a browser, the generator needs:
- **`files`**: your `.ts/.d.ts` sources as strings
- **`rootNames`**: entrypoints (defaults to `Object.keys(files)`)
- **`compilerOptions`**: optional TS compiler options
- **`lib`**: TypeScript standard library `.d.ts` files (unless you set `compilerOptions.noLib = true`)

### Example 1: simplest (no standard library)

Use this when your types don’t rely on built-in lib types (`Array`, `Record`, `Promise`, `Date`, etc).

```ts
import { createGenerator } from "@yarikleto/browser-ts-json-schema-generator";

const config = {
  type: "MyType",
  // Without TypeScript lib `.d.ts` files, TypeScript will report missing global types.
  // Schema generation still works, but you should skip type-checking.
  skipTypeCheck: true,
  files: {
    "/main.ts": `
      export interface MyType {
        name: string;
      }
    `,
  },
  rootNames: ["/main.ts"],
  compilerOptions: { noLib: true },
};

const schema = createGenerator(config).createSchema(config.type);
console.log(schema);
```

### Example 2: with TypeScript lib `.d.ts`

If you use lib types (like `string[]`, `Promise<T>`, `Date`, etc), provide the TS lib `.d.ts` content in `config.lib`.

#### How to provide `lib.d.ts` in a browser

You must provide the default lib file that TypeScript expects for your `compilerOptions` (and any referenced libs).
In practice, the easiest approaches are:

- **Bundle the `.d.ts` files into your app** (recommended).
- **Fetch the `.d.ts` files at runtime** (works, but adds network requests).

##### Option A: bundle `.d.ts` files (Vite example)

```ts
// Complete Vite example (copy/paste)
import { createGenerator, ts } from "@yarikleto/browser-ts-json-schema-generator";

// Vite can import text files as strings using `?raw`.
// These files come from your installed `typescript` package.
// Add `lib.dom.d.ts` only if you use DOM types (Window, Document, HTMLElement, ...).
import libEs2022 from "typescript/lib/lib.es2022.d.ts?raw";
import libEs5 from "typescript/lib/lib.es5.d.ts?raw";

const config = {
  type: "MyType",
  files: {
    "/main.ts": `
      export interface MyType {
        tags: string[];
      }
    `,
  },
  rootNames: ["/main.ts"],
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  lib: {
    "lib.es2022.d.ts": libEs2022,
    "lib.es5.d.ts": libEs5,
  },
};

const schema = createGenerator(config).createSchema(config.type);
console.log(schema);
```

##### Option B: fetch `.d.ts` files at runtime (CDN example)

```ts
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return await res.text();
}

async function loadTsLib(version = "5.9.3") {
  const base = `https://unpkg.com/typescript@${version}/lib/`;
  // Add more files if your target/lib selection requires them.
  // Add `lib.dom.d.ts` only if you use DOM types (Window, Document, HTMLElement, ...).
  const names = ["lib.es2022.d.ts", "lib.es5.d.ts"];
  const entries = await Promise.all(names.map(async (n) => [n, await fetchText(base + n)] as const));
  return Object.fromEntries(entries);
}
```

```ts
import { createGenerator, ts } from "@yarikleto/browser-ts-json-schema-generator";

const lib = await loadTsLib("5.9.3");

const config = {
  type: "MyType",
  files: {
    "/main.ts": `
      export interface MyType {
        tags: string[];
      }
    `,
  },
  rootNames: ["/main.ts"],
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  lib,
};

const schema = createGenerator(config).createSchema(config.type);
```

### Example 3: build schema for all exported types

```ts
import { createGenerator } from "@yarikleto/browser-ts-json-schema-generator";

const config = {
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
};

const schema = createGenerator(config).createSchema(config.type);
```

### Advanced: bring your own `ts.Program`

If you already have a TypeScript `Program` (for example from a language service / editor), pass it via `config.tsProgram` and the generator will use it directly.

### Notes

- **Imports between your in-memory files** work as long as you include all referenced files in `config.files`.
- The generator does **not** fetch dependencies for you. If your sources import external packages, you must provide their `.d.ts` content in `config.files` too.
