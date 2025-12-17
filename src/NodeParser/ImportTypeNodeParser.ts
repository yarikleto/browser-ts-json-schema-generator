import ts from "typescript";
import { Context } from "../NodeParser.js";
import type { NodeParser } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import type { BaseType } from "../Type/BaseType.js";
import { UnknownType } from "../Type/UnknownType.js";

export class ImportTypeNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) { }

    public supportsNode(node: ts.ImportTypeNode): boolean {
        return node.kind === ts.SyntaxKind.ImportType;
    }

    public createType(node: ts.ImportTypeNode, context: Context): BaseType {
        // IMPORTANT: `typeChecker.getTypeFromTypeNode(importType)` can return the *enclosing alias* (e.g. `A`)
        // when the import type appears inside a type alias. That can create circular $ref like { $ref: "#/definitions/A" }.
        //
        // Prefer resolving the imported symbol directly from `node.qualifier` and parsing its declaration with a
        // sub-context that contains the import type arguments.
        try {
            if (node.qualifier) {
                let symbol = this.typeChecker.getSymbolAtLocation(node.qualifier);
                if (symbol && (symbol.flags & ts.SymbolFlags.Alias)) {
                    symbol = this.typeChecker.getAliasedSymbol(symbol);
                }

                // For `typeof import("./mod").value`, we need the value declaration.
                // For `import("./mod").Type`, we need the type declaration.
                const decl = node.isTypeOf
                    ? (symbol as any)?.valueDeclaration ?? symbol?.declarations?.[0]
                    : symbol?.declarations?.[0];

                if (decl) {
                    return this.childNodeParser.createType(decl, this.createSubContext(node, context));
                }
            }
        } catch {
            // Fall back below.
        }

        // Fallback: ask TypeScript to reduce this node, but avoid infinite recursion on equivalent import types.
        if (node.pos !== -1) {
            try {
                const tsType = this.typeChecker.getTypeFromTypeNode(node);
                if ((tsType.flags & ts.TypeFlags.TypeParameter) && tsType.symbol?.name) {
                    const mapped = context.getArgument(tsType.symbol.name);
                    if (mapped) return mapped;
                }

                const reduced = this.typeChecker.typeToTypeNode(
                    tsType,
                    node,
                    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors,
                );

                if (reduced && !this.isSameImportTypeNode(node, reduced)) {
                    return this.childNodeParser.createType(reduced, context);
                }
            } catch {
                // ignore
            }
        }

        return new UnknownType(true);
    }

    private createSubContext(node: ts.ImportTypeNode, parentContext: Context): Context {
        const sub = new Context(node);
        if (node.typeArguments?.length) {
            for (const t of node.typeArguments) {
                sub.pushArgument(this.childNodeParser.createType(t, parentContext));
            }
        }
        return sub;
    }

    private isSameImportTypeNode(a: ts.ImportTypeNode, b: ts.Node): boolean {
        if (!ts.isImportTypeNode(b)) return false;
        if (a.isTypeOf !== b.isTypeOf) return false;

        const aMod = this.getImportArgLiteralText(a);
        const bMod = this.getImportArgLiteralText(b);
        if (aMod !== undefined && bMod !== undefined && aMod !== bMod) return false;

        // Compare qualifier if both are identifiers
        if (a.qualifier && b.qualifier) {
            if (ts.isIdentifier(a.qualifier) && ts.isIdentifier(b.qualifier)) {
                if (a.qualifier.escapedText !== b.qualifier.escapedText) return false;
            } else {
                // different qualifier shapes -> treat as different
                return false;
            }
        } else if (!!a.qualifier !== !!b.qualifier) {
            return false;
        }

        const aLen = a.typeArguments?.length ?? 0;
        const bLen = b.typeArguments?.length ?? 0;
        if (aLen !== bLen) return false;

        return true;
    }

    private getImportArgLiteralText(node: ts.ImportTypeNode): string | undefined {
        // argument: LiteralTypeNode(StringLiteral)
        const arg = node.argument;
        if (!ts.isLiteralTypeNode(arg)) return undefined;
        const lit = arg.literal;
        if (!ts.isStringLiteral(lit)) return undefined;
        return lit.text;
    }
}


