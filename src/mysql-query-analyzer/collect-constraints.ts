import { RuleContext } from "antlr4ts";

import {
    QueryContext, PrimaryExprCompareContext, BitExprContext, SimpleExprColumnRefContext, SimpleExprLiteralContext,
    SimpleExprParamMarkerContext, SimpleExprCaseContext, SimpleExprFunctionContext, SimpleExprSumContext,
    PredicateExprInContext, PredicateContext, SimpleExprSubQueryContext, QuerySpecificationContext,
    SimpleExprListContext, ExprListContext, PrimaryExprIsNullContext, ExprContext, ExprIsContext, BoolPriContext, 
    PrimaryExprPredicateContext, SimpleExprContext, PredicateOperationsContext, ExprNotContext, ExprAndContext, 
    ExprOrContext, ExprXorContext, PredicateExprLikeContext, SelectStatementContext, SimpleExprRuntimeFunctionContext, 
    SubqueryContext, InsertStatementContext
} from "ts-mysql-parser";

import { ColumnSchema, ColumnDef, TypeInferenceResult } from "./types";
import { getColumnsFrom, findColumn, splitName, selectAllColumns, findColumn2 } from "./select-columns";
import { unify, SubstitutionHash, getQuerySpecificationsFromSelectStatement as getQuerySpecificationsFromQuery, 
    analiseQuery, getQuerySpecificationsFromSelectStatement } from "./parse";
import { MySqlType } from "../mysql-mapping";

export type TypeVar = {
    kind: 'TypeVar';
    id: number;
    name: string;
    type: MySqlType | '?' | 'number';
    list?: true;
    selectItem?: true
}

export type Type = TypeVar | TypeOperator;

type TypeOperator = {
    kind: 'TypeOperator';
    types: Type[];
    selectItem?: true
};


export type Constraint = {
    type1: Type;
    type2: Type;
    expression: string;
    mostGeneralType?: true;
    list?: true;
    sum?: 'sum';
    strict?: boolean;
    functionName?: 'sum'
}

let counter = 0;
export function freshVar(name: string, typeVar: MySqlType | '?' | 'number', selectItem?: true, list?: true): TypeVar {
    const param: TypeVar = {
        kind: 'TypeVar',
        id: ++counter,
        name,
        type: typeVar

    }
    if (list) {
        param.list = true;
    }
    if (selectItem) {
        param.selectItem = true;
    }
    return param;
}


export type NamedNodes = {
    [key: string]: Type;
}

// export function collectConstraints(node: RuleContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[]) {

//     if (node instanceof UpdateElementContext) {
//         const colRef = node.columnRef();
//         const colRefType = addNamedNode(colRef, freshVar(colRef.text, 'int'), namedNodes);
//         const expr = node.expr();
//         if (expr) {
//             collectConstraints(expr, namedNodes, constraints, dbSchema);
//             const exprType = getType(expr, namedNodes);
//             constraints.push({
//                 expression: node.text,
//                 type1: colRefType,
//                 type2: exprType
//             })
//         }
//         return;
//     }
// }

export function analiseTree(tree: RuleContext, dbSchema: ColumnSchema[]) {

    if (tree instanceof QueryContext) {

        const selectStatement = tree.simpleStatement()?.selectStatement();
        if (selectStatement) {
            return analiseSelectStatement(selectStatement, dbSchema);
        }
        const insertStatement = tree.simpleStatement()?.insertStatement();
        if(insertStatement) {
            return analiseInsertStatement(insertStatement, dbSchema);
        }

        // const updateExpr = tree.simpleStatement()?.updateStatement()?.updateList().updateElement();
        // updateExpr?.forEach(updateElement => {
        //     //collectConstraints(updateElement, namedNodes, constraints, dbSchema);
        // })
        // return constraints;


    }
    throw Error('invalid type of tree');

}

export function analiseInsertStatement(insertStatement: InsertStatementContext, dbSchema: ColumnSchema[]): TypeInferenceResult {
    const constraints: Constraint[] = [];
    const namedNodes: TypeVar[] = [];

    const valuesContext = insertStatement.insertFromConstructor()!.insertValues().valueList().values()[0];
    
    const insertColumns = getInsertColumns(insertStatement, dbSchema);
    const result = valuesContext.expr().map( expr => {
        const result = walkExpr(expr, namedNodes, constraints, insertColumns, []);
        return result;
    })

    constraints.push({
        expression: insertStatement.text,
        type1: {
            kind: 'TypeOperator',
            types: insertColumns.map( field => freshVar(field.column, field.column_type))
        },
        type2: {
            kind: 'TypeOperator',
            types: result
        }
    })

    const substitutions: SubstitutionHash = {}
    unify(constraints, substitutions);

    const parameters = namedNodes.map(param => {
        if(param.type != '?') return param.type  as MySqlType;
        const type = substitutions[param.id];
        if (!type) {
            return 'varchar' as MySqlType;
        }
        if (type.type == 'number') return 'double';
        const resultType = type.list ? type.type + '[]' : type.type;
        return resultType as MySqlType;
    });

    console.log("parameters=", parameters);
    const typeInfer : TypeInferenceResult = {
        columns: [],
        parameters
    }
    return typeInfer;
}

export function getInsertColumns(insertStatement: InsertStatementContext, dbSchema: ColumnSchema[]) {
    const insertIntoTable = splitName(insertStatement.tableRef().text).name;

    const fields : ColumnSchema[] = insertStatement.insertFromConstructor()!.fields()!.insertIdentifier().map( insertIdentifier => {
        const colRef = insertIdentifier.columnRef();
        if(colRef) {
            const fieldName = splitName(colRef.text);
            const column = findColumn2(fieldName, insertIntoTable, dbSchema);
            return column;

        }
        throw Error('Invalid sql');
        
    });
    return fields;
}


function analiseSelectStatement(selectStatement: SelectStatementContext, dbSchema: ColumnSchema[]): TypeInferenceResult {
    const querySpec = getQuerySpecificationsFromSelectStatement(selectStatement);
    const fromColumns = getColumnsFrom(querySpec[0], dbSchema);
    let result = analiseQuerySpecification(querySpec[0], dbSchema, fromColumns);
    for (let index = 1; index < querySpec.length; index++) {
        const unionQuery = querySpec[index];
        const fromColumns2 = getColumnsFrom(unionQuery, dbSchema);
        const result2 = analiseQuerySpecification(unionQuery, dbSchema, fromColumns2);
        result = unionResult(result, result2);
        
    }
    return result;
}

function unionResult(typeInference1: TypeInferenceResult, typeInference2: TypeInferenceResult): TypeInferenceResult {
    const resultColumnTypes = typeInference1.columns.map((col1, index) => {
        const col2 = typeInference2.columns[index];
        const resultType = unionTypeResult(col1, col2);
        return resultType;
    });

    return {
        columns: resultColumnTypes,
        parameters: [...typeInference1.parameters, ...typeInference2.parameters] //TODO-INVERSE?
    }
}

export function unionTypeResult(type1: MySqlType, type2: MySqlType) {
    const typeOrder: MySqlType[] = ['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'float', 'double', 'varchar'];
    const indexType1 = typeOrder.indexOf(type1);
    const indexType2 = typeOrder.indexOf(type2);
    const max = Math.max(indexType1, indexType2);
    return typeOrder[max];
}

export function analiseQuerySpecification(querySpec: QuerySpecificationContext, dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): TypeInferenceResult {

    const constraints: Constraint[] = [];
    const namedNodes: TypeVar[] = [];

    const queryTypes = walkQuerySpecification(querySpec, namedNodes, constraints, dbSchema, fromColumns) as TypeOperator;
    // console.log("namedNodes");
    // console.dir(namedNodes, { depth: null });
    // console.log("constraints2=");
    // console.dir(constraints, { depth: null });

    const substitutions: SubstitutionHash = {}
    unify(constraints, substitutions);

    const parameters = namedNodes.map(param => {
        if(param.type != '?') return param.type  as MySqlType;
        const type = substitutions[param.id];
        if (!type) {
            return 'varchar' as MySqlType;
        }
        if (type.type == 'number') return 'double';
        const resultType = type.list ? type.type + '[]' : type.type;
        return resultType as MySqlType;
    });

    const columnTypes: MySqlType[] = queryTypes.types.map(param => {
        if (param.kind == 'TypeVar') {

            const type = substitutions[param.id];
            if (!type || type.type == '?') {
                if (param.type != '?') {
                    return param.type == 'number' ? 'double' : param.type;
                }
                return 'varchar'

            }
            return type.type == 'number' ? 'double' : type.type;
        }
        return 'varchar'

    });



    const querySpecResult: TypeInferenceResult = {
        parameters: parameters,
        columns: columnTypes
    }
    return querySpecResult;
}


function walkQuerySpecification(querySpec: QuerySpecificationContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {

    const listType: TypeVar[] = [];

    if (querySpec.selectItemList().MULT_OPERATOR()) {

        fromColumns.forEach(col => {
            const colType = freshVar(col.columnName, col.columnType);
            listType.push(colType);
        })
    }

    querySpec.selectItemList().selectItem().forEach(selectItem => {
        const tableWild = selectItem.tableWild(); //ex. t1.*
        if (tableWild?.MULT_OPERATOR()) {
            tableWild.identifier().forEach(tabWild => {
                const prefix = tabWild.text;
                const columns = selectAllColumns(prefix, fromColumns);
                columns.forEach(col => {
                    const colType = freshVar(col.columnName, col.columnType);
                    listType.push(colType);
                })
            });

        }
        else {
            const expr = selectItem.expr();
            if (expr) {
                const exprType = walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
                if (exprType.kind == 'TypeOperator') {
                    const subqueryType = exprType.types[0] as TypeVar;
                    listType.push(subqueryType);
                }
                else {
                    listType.push(exprType);
                }

            }
        }

    })
    const typeOperator: TypeOperator = {
        kind: 'TypeOperator',
        selectItem: true,
        types: listType
    }

    const whereClause = querySpec.whereClause();
    //TODO - FROM, HAVING, BLAH
    if (whereClause) {
        const whereExpr = whereClause?.expr();
        walkExpr(whereExpr, namedNodes, constraints, dbSchema, fromColumns);
    }
    return typeOperator;
}

function walkExpr(expr: ExprContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {

    if (expr instanceof ExprIsContext) {
        const boolPri = expr.boolPri();
        const boolPriType = walkBoolPri(boolPri, namedNodes, constraints, dbSchema, fromColumns);
        return boolPriType;
    }
    if (expr instanceof ExprNotContext) {
        return freshVar(expr.text, 'tinyint');;
    }
    if (expr instanceof ExprAndContext || expr instanceof ExprXorContext || expr instanceof ExprOrContext) {
        const exprLeft = expr.expr()[0];
        walkExpr(exprLeft, namedNodes, constraints, dbSchema, fromColumns);
        const exprRight = expr.expr()[1];
        walkExpr(exprRight, namedNodes, constraints, dbSchema, fromColumns);
        return freshVar(expr.text, 'tinyint');
    }
    throw Error('invalid type');

}

function walkBoolPri(boolPri: BoolPriContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {

    if (boolPri instanceof PrimaryExprPredicateContext) {
        const predicate = boolPri.predicate();
        const predicateType = walkPredicate(predicate, namedNodes, constraints, dbSchema, fromColumns);
        return predicateType;
    }
    if (boolPri instanceof PrimaryExprIsNullContext) {
        const boolPri2 = boolPri.boolPri();
        walkBoolPri(boolPri2, namedNodes, constraints, dbSchema, fromColumns);
        return freshVar(boolPri.text, '?');
    }

    if (boolPri instanceof PrimaryExprCompareContext) {

        const compareLeft = boolPri.boolPri();
        const compareRight = boolPri.predicate();
        const typeLeft = walkBoolPri(compareLeft, namedNodes, constraints, dbSchema, fromColumns);
        const typeRight = walkPredicate(compareRight, namedNodes, constraints, dbSchema, fromColumns);

        constraints.push({
            expression: boolPri.text,
            type1: typeLeft,
            type2: typeRight,
            strict: true
        })
        return freshVar(boolPri.text, 'tinyint');
    }
    throw Error('invalid sql');

}

function walkPredicate(predicate: PredicateContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {

    const bitExpr = predicate.bitExpr()[0];
    const bitExprType = walkBitExpr(bitExpr, namedNodes, constraints, dbSchema, fromColumns);

    const predicateOperations = predicate.predicateOperations();
    if (predicateOperations) {
        const rightType = walkpredicateOperations(bitExprType, predicateOperations, namedNodes, constraints, dbSchema, fromColumns);
        constraints.push({
            expression: predicateOperations.text,
            type1: bitExprType, // ? array of id+id
            type2: rightType,
            // mostGeneralType: true,
            strict: true
        })
        return rightType;

    }
    // return freshVar(predicateOperations.text, 'tinyint');
    return bitExprType;
}

function walkpredicateOperations(parentType: Type, predicateOperations: PredicateOperationsContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]) : Type {
    if (predicateOperations instanceof PredicateExprInContext) {

        const subquery = predicateOperations.subquery();
        if (subquery) {
            const rightType = walkSubquery(subquery, dbSchema, namedNodes, fromColumns);
            return rightType;
        }
        const exprList = predicateOperations.exprList();
        if (exprList) {
            const rightType = walkExprList(exprList, namedNodes, constraints, dbSchema, fromColumns);
            return rightType;
        }
       
    }

    if (predicateOperations instanceof PredicateExprLikeContext) {
        const simpleExpr = predicateOperations.simpleExpr()[0];
        const rightType = walkSimpleExpr(simpleExpr, namedNodes, constraints, dbSchema, fromColumns);
        constraints.push({
            expression: simpleExpr.text,
            type1: parentType,
            type2: rightType
        })
        return rightType;

    }
    throw Error("Not expected");

}

function walkExprList(exprList: ExprListContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {

    const listType = exprList.expr().map(item => {
        const exprType = walkExpr(item, namedNodes, constraints, dbSchema, fromColumns);
        return exprType;

    })
    const type: TypeOperator = {
        kind: 'TypeOperator',
        types: listType
    }
    return type;
}

function walkBitExpr(bitExpr: BitExprContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {
    const simpleExpr = bitExpr.simpleExpr();
    if (simpleExpr) {
        return walkSimpleExpr(simpleExpr, namedNodes, constraints, dbSchema, fromColumns);
    }

    if (bitExpr.bitExpr().length == 2) {

        const bitExprType = freshVar(bitExpr.text, 'number');

        const bitExprLeft = bitExpr.bitExpr()[0];
        const typeLeftTemp = walkBitExpr(bitExprLeft, namedNodes, constraints, dbSchema, fromColumns);
        const typeLeft = typeLeftTemp.kind == 'TypeOperator' ? typeLeftTemp.types[0] as TypeVar : typeLeftTemp;
        //const newTypeLeft = typeLeft.name == '?'? freshVar('?', 'bigint') : typeLeft;

        const bitExprRight = bitExpr.bitExpr()[1]
        const typeRightTemp = walkBitExpr(bitExprRight, namedNodes, constraints, dbSchema, fromColumns);

        //In the expression 'id + (value + 2) + ?' the '(value+2)' is treated as a SimpleExprListContext and return a TypeOperator
        const typeRight = typeRightTemp.kind == 'TypeOperator' ? typeRightTemp.types[0] as TypeVar : typeRightTemp;
        //const newTypeRight = typeRight.name == '?'? freshVar('?', 'bigint') : typeRight;

        constraints.push({
            expression: bitExpr.text,
            type1: typeLeft,
            type2: typeRight,
            mostGeneralType: true,
            sum: 'sum'
        })
        constraints.push({
            expression: bitExpr.text,
            type1: bitExprType,
            type2: typeLeft,
            mostGeneralType: true,
            sum: 'sum'
        })
        constraints.push({
            expression: bitExpr.text,
            type1: bitExprType,
            type2: typeRight,
            mostGeneralType: true,
            sum: 'sum'
        })
        return bitExprType;
    }
    const expr = bitExpr.expr();
    if (expr) {
        walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
    }
    throw Error('Invalid sql');
}

function walkSimpleExpr(simpleExpr: SimpleExprContext, namedNodes: TypeVar[], constraints: Constraint[], dbSchema: ColumnSchema[], fromColumns: ColumnDef[]): Type {
    if (simpleExpr instanceof SimpleExprColumnRefContext) {
        const fieldName = splitName(simpleExpr.text);
        const columnType = findColumn(fieldName, fromColumns).columnType;
        const type = freshVar(simpleExpr.text, columnType);
        return type;
    }

    if (simpleExpr instanceof SimpleExprRuntimeFunctionContext) {
        const runtimeFunctionCall = simpleExpr.runtimeFunctionCall();
        if (runtimeFunctionCall.MINUTE_SYMBOL()) {
            const expr = runtimeFunctionCall.exprWithParentheses()?.expr();
            if (expr) {
                const paramType = walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: expr.text,
                    type1: paramType,
                    type2: freshVar(simpleExpr.text, 'varchar')
                })
            }
            return freshVar(simpleExpr.text, 'smallint');
        }
        throw Error('SimpleExprRuntimeFunctionContext');
    }

    if (simpleExpr instanceof SimpleExprFunctionContext) {
        const functionIdentifier = simpleExpr.functionCall().pureIdentifier()?.text || simpleExpr.functionCall().qualifiedIdentifier()?.text;

        if (functionIdentifier?.toLowerCase() === 'concat_ws' || functionIdentifier?.toLowerCase() === 'concat') {
            const functionType = freshVar(simpleExpr.text, '?');
            const udfExprList = simpleExpr.functionCall().udfExprList()?.udfExpr();
            udfExprList?.forEach(udfExpr => {
                const expr = udfExpr.expr();
                const paramType = walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: expr.text,
                    type1: paramType,
                    type2: functionType
                })
            })
            return functionType;
        }

        if (functionIdentifier?.toLowerCase() === 'avg') {
            const functionType = freshVar(simpleExpr.text, '?');
            constraints.push({
                expression: simpleExpr.text,
                type1: functionType,
                type2: freshVar('decimal', 'decimal'),
                mostGeneralType: true
            })
            const exprList = simpleExpr.functionCall().exprList()?.expr();
            exprList?.forEach(inExpr => {
                const inSumExprType = walkExpr(inExpr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: simpleExpr.text,
                    type1: functionType,
                    type2: inSumExprType,
                    mostGeneralType: true
                })
            })
            return functionType;
        }

        if (functionIdentifier?.toLowerCase() === 'round') {
            const functionType = freshVar(simpleExpr.text, '?');
            const exprList = simpleExpr.functionCall().udfExprList()?.udfExpr();
            const parametersType = exprList?.map(inExpr => {
                const expr = inExpr.expr();
                const inSumExprType = walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
                return inSumExprType;
            })!

            //The return value has the same type as the first argument
            constraints.push({
                expression: simpleExpr.text,
                type1: functionType,
                type2: parametersType[0], //type of the first parameter
                mostGeneralType: true
            })
            return functionType;
        }

        if (functionIdentifier?.toLowerCase() === 'floor') {
            const exprList = simpleExpr.functionCall().udfExprList()?.udfExpr();
            exprList?.forEach(inExpr => {
                const expr = inExpr.expr();
                const exprType = walkExpr(expr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: expr.text,
                    type1: exprType,
                    type2: freshVar(expr.text, 'double'),
                    mostGeneralType: true
                })
            })
            return freshVar(simpleExpr.text, 'bigint');
        }
        throw Error('SimpleExprRuntimeFunctionContext');
    }

    if (simpleExpr instanceof SimpleExprParamMarkerContext) {
        const param = freshVar('?', '?');
        // addNamedNode2(simpleExpr, param, namedNodes);
        namedNodes.push(param);
        return param;
    }

    if (simpleExpr instanceof SimpleExprSumContext) {

        if (simpleExpr.sumExpr().MAX_SYMBOL() || simpleExpr.sumExpr().MIN_SYMBOL()) {
            const functionType = freshVar(simpleExpr.text, '?');
            const inSumExpr = simpleExpr.sumExpr().inSumExpr()?.expr();
            if (inSumExpr) {
                const inSumExprType = walkExpr(inSumExpr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: simpleExpr.text,
                    type1: functionType,
                    type2: inSumExprType,
                    mostGeneralType: true
                })
            }
            return functionType;
        }
        if (simpleExpr.sumExpr().COUNT_SYMBOL()) {
            const functionType = freshVar(simpleExpr.text, 'bigint');
            const inSumExpr = simpleExpr.sumExpr().inSumExpr()?.expr();
            if (inSumExpr) {
                walkExpr(inSumExpr, namedNodes, constraints, dbSchema, fromColumns);
            }
            return functionType;
        }

        if (simpleExpr.sumExpr().SUM_SYMBOL() || simpleExpr.sumExpr().AVG_SYMBOL()) {
            const functionType = freshVar(simpleExpr.text, '?');
            const inSumExpr = simpleExpr.sumExpr().inSumExpr()?.expr();
            if (inSumExpr) {
                const inSumExprType = walkExpr(inSumExpr, namedNodes, constraints, dbSchema, fromColumns);
                constraints.push({
                    expression: simpleExpr.text,
                    type1: functionType,
                    type2: inSumExprType,
                    mostGeneralType: true,
                    functionName: 'sum'
                })
            }
            return functionType;
        }
    }

    if (simpleExpr instanceof SimpleExprLiteralContext) {
        const literal = simpleExpr.literal();

        if (literal.textLiteral()) {
            return freshVar('varchar', 'varchar');
        }
        const numLiteral = literal.numLiteral();
        if (numLiteral) {
            return freshVar(numLiteral.text, 'bigint');
            // addNamedNode(simpleExpr, freshVar('bigint', 'bigint'), namedNodes)
            // if(numLiteral.INT_NUMBER()) {
            //     const typeInt = freshVar('int', 'int');
            //     addNamedNode(simpleExpr, typeInt, namedNodes)
            // }
            // if(numLiteral.DECIMAL_NUMBER()) {
            //     const typeDecimal = freshVar('decimal', 'decimal');
            //     addNamedNode(simpleExpr, typeDecimal, namedNodes)
            // }
            // if(numLiteral.FLOAT_NUMBER()) {
            //     const typeFloat = freshVar('float', 'float');
            //     addNamedNode(simpleExpr, typeFloat, namedNodes)
            // }
            ;
        }
        throw Error('SimpleExprLiteralContext');
        //...
    }

    if (simpleExpr instanceof SimpleExprListContext) {
        const exprList = simpleExpr.exprList();

        const listType = exprList.expr().map(item => {
            const exprType = walkExpr(item, namedNodes, constraints, dbSchema, fromColumns);
            return exprType;
        })
        const resultType: TypeOperator = {
            kind: 'TypeOperator',
            types: listType
        }
        return resultType;

    }

    if (simpleExpr instanceof SimpleExprSubQueryContext) {
        const subquery = simpleExpr.subquery();
        const subqueryType = walkSubquery(subquery, dbSchema, namedNodes, fromColumns);
        return subqueryType;
    }

    if (simpleExpr instanceof SimpleExprCaseContext) {

        //case when expr then expr else expr
        const caseType = freshVar(simpleExpr.text, '?');

        simpleExpr.whenExpression().forEach(whenExprCont => {
            const whenExpr = whenExprCont.expr();
            const whenType = walkExpr(whenExpr, namedNodes, constraints, dbSchema, fromColumns);

            constraints.push({
                expression: whenExpr.text,
                type1: whenType.kind == 'TypeOperator' ? whenType.types[0] : whenType,
                type2: freshVar('tinyint', 'tinyint') //bool
            })
        })

        const thenTypes = simpleExpr.thenExpression().map(thenExprCtx => {
            const thenExpr = thenExprCtx.expr();
            const thenType = walkExpr(thenExpr, namedNodes, constraints, dbSchema, fromColumns);

            constraints.push({
                expression: thenExprCtx.text,
                type1: caseType,
                type2: thenType,
                mostGeneralType: true,
            })
            return thenType;
        })


        const elseExpr = simpleExpr.elseExpression()?.expr();
        if (elseExpr) {
            const elseType = walkExpr(elseExpr, namedNodes, constraints, dbSchema, fromColumns);

            constraints.push({
                expression: simpleExpr.elseExpression()?.text!,
                type1: caseType,
                type2: elseType,
                mostGeneralType: true
            })
            thenTypes.forEach(thenType => {
                constraints.push({
                    expression: simpleExpr.elseExpression()?.text!,
                    type1: thenType,
                    type2: elseType,
                    mostGeneralType: true
                })

            })
        }
        return caseType;
    }
    throw Error('Invalid expression');
}

export function walkSubquery(queryExpressionParens: SubqueryContext, dbSchema: ColumnSchema[], namedNodes: TypeVar[], fromColumns: ColumnDef[]): Type {

    const querySpec = getQuerySpecificationsFromQuery(queryExpressionParens);
    const typeInferResult = analiseQuery(querySpec, dbSchema, fromColumns);
    const typeVars = typeInferResult.columns.map(col => {
        const typeVar = freshVar(col.columnName, col.type);
        
        return typeVar;
    })
    typeInferResult.parameters.forEach( param => {
        namedNodes.push(freshVar('?', param.type));
    })
    const type: TypeOperator = {
        kind: 'TypeOperator',
        types: typeVars
    };
    return type;

}