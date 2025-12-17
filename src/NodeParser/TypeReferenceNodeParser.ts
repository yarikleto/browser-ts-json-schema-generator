import ts from "typescript";
import { Context, type NodeParser } from "../NodeParser.js";
import type { SubNodeParser } from "../SubNodeParser.js";
import { AnnotatedType } from "../Type/AnnotatedType.js";
import { AnyType } from "../Type/AnyType.js";
import { ArrayType } from "../Type/ArrayType.js";
import type { BaseType } from "../Type/BaseType.js";
import { StringType } from "../Type/StringType.js";
import { UnknownType } from "../Type/UnknownType.js";
import { symbolAtNode } from "../Utils/symbolAtNode.js";

const invalidTypes: Record<number, boolean> = {
    [ts.SyntaxKind.ModuleDeclaration]: true,
    [ts.SyntaxKind.VariableDeclaration]: true,
};

function containsSyntaxKind(node: ts.Node, kind: ts.SyntaxKind): boolean {
    if (node.kind === kind) return true;
    let found = false;
    ts.forEachChild(node, (child) => {
        if (!found && containsSyntaxKind(child, kind)) found = true;
    });
    return found;
}

export class TypeReferenceNodeParser implements SubNodeParser {
    public constructor(
        protected typeChecker: ts.TypeChecker,
        protected childNodeParser: NodeParser,
    ) { }

    public supportsNode(node: ts.TypeReferenceNode): boolean {
        return node.kind === ts.SyntaxKind.TypeReference;
    }

    public createType(node: ts.TypeReferenceNode, context: Context): BaseType {
        const typeSymbol =
            this.typeChecker.getSymbolAtLocation(node.typeName) ??
            // When the node doesn't have a valid source file, its position is -1, so we can't
            // search for a symbol based on its location. In that case, the ts.factory may define a `symbol`
            // property on the node itself.
            symbolAtNode(node.typeName);

        // Synthetic/reduced nodes (e.g. produced by typeToTypeNode) may not carry a symbol.
        // Fall back gracefully rather than crashing.
        if (!typeSymbol) {
            return new UnknownType(true);
        }

        const reduceViaTypeScript = new Set([
            // Utility types that rely on conditional types + `infer` in lib.*.d.ts and are hard to model
            // correctly with our schema-oriented FunctionType.
            "ReturnType",
            "Parameters",
            "ConstructorParameters",
            "InstanceType",
            "ThisParameterType",
            "OmitThisParameter",
            "Awaited",
        ]);

        // For some utility types (notably ReturnType<...>) we need TypeScript itself to compute the instantiated type.
        // Our internal FunctionType is schema-oriented (comment-only) and can't support conditional-type inference.
        //
        // IMPORTANT: avoid doing this for sourceless/synthetic nodes (pos === -1) and keep the scope narrow,
        // because `typeToTypeNode` may produce synthetic nodes that don't carry symbols and can break other parsers.
        const shouldReduce =
            reduceViaTypeScript.has(typeSymbol.name) ||
            (() => {
                // If this is a generic alias that contains `infer` (common in TS utility types),
                // prefer letting TypeScript compute the instantiated type.
                if (!(typeSymbol.flags & ts.SymbolFlags.Alias)) return false;
                const aliased = this.typeChecker.getAliasedSymbol(typeSymbol);
                const decl = aliased.declarations?.filter((n: ts.Declaration) => !invalidTypes[n.kind])[0];
                return !!(decl && ts.isTypeAliasDeclaration(decl) && containsSyntaxKind(decl.type, ts.SyntaxKind.InferType));
            })();

        if (node.pos !== -1 && node.typeArguments?.length && shouldReduce) {
            try {
                const tsType = this.typeChecker.getTypeFromTypeNode(node);
                const reduced = this.typeChecker.typeToTypeNode(
                    tsType,
                    node,
                    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.IgnoreErrors,
                );

                // Avoid infinite recursion when TS returns the exact same type reference node.
                if (
                    reduced &&
                    !(ts.isTypeReferenceNode(reduced) &&
                        reduced.typeName.getText() === node.typeName.getText() &&
                        (reduced.typeArguments?.length ?? 0) === (node.typeArguments?.length ?? 0))
                ) {
                    return this.childNodeParser.createType(reduced, context);
                }
            } catch {
                // Fall back to the regular node-based implementation below.
            }
        }

        if (typeSymbol.flags & ts.SymbolFlags.Alias) {
            const aliasedSymbol = this.typeChecker.getAliasedSymbol(typeSymbol);

            const declaration = aliasedSymbol.declarations?.filter((n: ts.Declaration) => !invalidTypes[n.kind])[0];

            if (!declaration) {
                // fallback for bun.sh
                return new AnyType();
            }

            return this.childNodeParser.createType(declaration, this.createSubContext(node, context));
        }

        if (typeSymbol.flags & ts.SymbolFlags.TypeParameter) {
            return context.getArgument(typeSymbol.name) ?? new UnknownType(true);
        }

        // Wraps promise type to avoid resolving to a empty Object type.
        if (typeSymbol.name === "Promise" || typeSymbol.name === "PromiseLike") {
            // Promise without type resolves to Promise<any>
            if (!node.typeArguments || node.typeArguments.length === 0) {
                return new AnyType();
            }

            return this.childNodeParser.createType(node.typeArguments[0], context);
        }

        if (typeSymbol.name === "Array" || typeSymbol.name === "ReadonlyArray") {
            const type = this.createSubContext(node, context).getArguments()[0];

            return type === undefined ? new AnyType() : new ArrayType(type);
        }

        if (typeSymbol.name === "Date") {
            return new AnnotatedType(new StringType(), { format: "date-time" }, false);
        }

        if (typeSymbol.name === "RegExp") {
            return new AnnotatedType(new StringType(), { format: "regex" }, false);
        }

        if (typeSymbol.name === "URL") {
            return new AnnotatedType(new StringType(), { format: "uri" }, false);
        }

        const decl = typeSymbol.declarations?.filter((n: ts.Declaration) => !invalidTypes[n.kind])[0];
        if (!decl) {
            // Some synthetic/ambient symbols may not have declarations attached.
            return new AnyType();
        }

        return this.childNodeParser.createType(decl, this.createSubContext(node, context));
    }

    protected createSubContext(node: ts.TypeReferenceNode, parentContext: Context): Context {
        const subContext = new Context(node);

        if (node.typeArguments?.length) {
            for (const typeArg of node.typeArguments) {
                subContext.pushArgument(this.childNodeParser.createType(typeArg, parentContext));
            }
        }

        return subContext;
    }
}
