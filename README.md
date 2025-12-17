# @yarikleto/browser-ts-json-schema-generator

[![npm version](https://img.shields.io/npm/v/%40yarikleto%2Fbrowser-ts-json-schema-generator.svg)](https://www.npmjs.com/package/@yarikleto/browser-ts-json-schema-generator)

Based on the [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator)

Generate **JSON Schema** from TypeScript types in the **browser**.

This fork is **browser-only**:
- No Node.js CLI
- No filesystem access
- You pass TypeScript sources as **strings** (`config.files`)
- You pass file decladations as **strings** (`config.lib`)

### Install

```bash
npm i @yarikleto/browser-ts-json-schema-generator
```

### How it works

To build a TypeScript `Program` in a browser, the generator needs:
- **`files`**: your `.ts/.d.ts` sources as strings
- **`rootNames`**: entrypoints (defaults to `Object.keys(files)`)
- **`compilerOptions`**: optional TS compiler options
- **`lib`**: in-memory TypeScript standard library `.d.ts` contents (unless you set `compilerOptions.noLib = true`)
  - `compilerOptions.lib` controls **which** lib files TypeScript wants to include (e.g. `["es5"]`)
  - `config.lib` must provide the **actual file contents** for those libs in browser/VFS mode (e.g. `"lib.es5.d.ts"`)
  - If `compilerOptions.noLib = true`, then TypeScript won’t include any libs, so `compilerOptions.lib` is effectively ignored
- **`skipTypeCheck`**: optional. Skips the “throw on TS diagnostics” gate. Note: when `compilerOptions.noLib = true`, the generator automatically skips this gate.

### Example 1: simplest (no standard library)

Use this when you don’t want to provide TypeScript lib `.d.ts` files.

```ts
import { createGenerator } from "@yarikleto/browser-ts-json-schema-generator";

const config = {
  type: "MyType",
  files: {
    "/main.ts": `
      export interface MyType {
        name: string;
      }
    `,
  },
  rootNames: ["/main.ts"],
  // No TypeScript standard library. In this mode the generator automatically skips the type-check gate.
  compilerOptions: { noLib: true },
};

const schema = createGenerator(config).createSchema(config.type);
console.log(schema);
```

### Example 2: with TypeScript lib `.d.ts`

If you use lib types (like `string[]`, `Promise<T>`, `Date`, etc), provide the TS lib `.d.ts` content in `config.lib`.

Tip: when you provide libs, you can keep the default behavior (type-check gate enabled) to catch TS errors early,
or set `skipTypeCheck: true` to skip the gate for performance.

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
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.ESNext,
  },
  lib: {
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
  const names = ["lib.es5.d.ts"];
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
    target: ts.ScriptTarget.ES5,
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
  files: {
    "/main.ts": `
      export interface A { a: string }
      export interface B { b: number }
    `,
  },
  rootNames: ["/main.ts"],
  // No TypeScript standard library. In this mode the generator automatically skips the type-check gate.
  compilerOptions: { noLib: true },
};

const schema = createGenerator(config).createSchema(config.type);
```

### Advanced: bring your own `ts.Program`

If you already have a TypeScript `Program` (for example from a language service / editor), pass it via `config.tsProgram` and the generator will use it directly.

### Notes

- **Imports between your in-memory files** work as long as you include all referenced files in `config.files`.
- The generator does **not** fetch dependencies for you. If your sources import external packages, you must provide their `.d.ts` content in `config.files` too.

### Custom declaration files (`.d.ts`)

Sometimes your code references types that don’t exist in your `files` (e.g. global `Context`, `Window`, or project-specific ambient types).
In Node.js, TypeScript usually finds these through `node_modules/@types` + `compilerOptions.types`.
In browser/VFS mode there is no filesystem, so you must provide those declarations **as strings** and tell TypeScript to include them.

#### Option A: global/ambient declarations (recommended for `declare interface Context`)

Put the `.d.ts` file content into `config.lib` and reference it via `compilerOptions.types`.

```ts
import { createGenerator, ts } from "@yarikleto/browser-ts-json-schema-generator";
import libEs5 from "typescript/lib/lib.es5.d.ts?raw";

const customDeclarations = `
  declare interface Context {
    name: string;
    innerObject: {
      name: string;
      age: number;
    };
  }
`;

const config = {
  type: "TransformResult",
  files: {
    "/user-code.ts": `
      export function transform(object: Context) {
        return object.innerObject.name;
      }
    `,
    "/index.ts": `
      import { transform } from "./user-code";
      export type TransformResult = ReturnType<typeof transform>;
    `,
  },
  rootNames: ["/index.ts"],
  compilerOptions: {
    target: ts.ScriptTarget.ES5,
    module: ts.ModuleKind.ESNext,
    // IMPORTANT: in VFS mode we resolve this from `config.lib` (not from node_modules/@types).
    // You can pass "context" or "context.d.ts".
    types: ["context.d.ts"],
  },
  lib: {
    "lib.es5.d.ts": libEs5,
    "context.d.ts": customDeclarations,
  },
};

const schema = createGenerator(config).createSchema(config.type);
```

#### Option B: module declarations (for imported types)

If you want a type to be *imported* (not global), put the `.d.ts` in `config.files` and import it normally:

```ts
// "/types.d.ts"
export interface Context { /* ... */ }
```

```ts
// "/main.ts"
import type { Context } from "./types";
```
