import ts from "typescript";

/**
 * Counts McCabe control-flow decision points inside a TypeScript/JavaScript AST subtree.
 * Cyclomatic complexity of a function is `1 + countTsControlFlowDecisions(fnNode)`.
 */
export function countTsControlFlowDecisions(rootNode: ts.Node): number {
  let decisions = 0;
  function walk(node: ts.Node): void {
    switch (node.kind) {
      case ts.SyntaxKind.IfStatement:
      case ts.SyntaxKind.ForStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.WhileStatement:
      case ts.SyntaxKind.DoStatement:
      case ts.SyntaxKind.CaseClause:
      case ts.SyntaxKind.CatchClause:
      case ts.SyntaxKind.ConditionalExpression:
        decisions++;
        break;
      case ts.SyntaxKind.BinaryExpression: {
        const bin = node as ts.BinaryExpression;
        if (
          bin.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          bin.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          bin.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        ) {
          decisions++;
        }
        break;
      }
    }
    ts.forEachChild(node, walk);
  }
  walk(rootNode);
  return decisions;
}
