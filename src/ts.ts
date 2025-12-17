import ts from "typescript";

/**
 * Re-export TypeScript for consumers of this package.
 *
 * Having a single import site also makes it easier for bundlers and tooling
 * to resolve TypeScript in browser builds.
 */
export default ts;


