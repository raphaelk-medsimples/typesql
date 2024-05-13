import { Select_stmtContext, Sql_stmtContext, ExprContext, Table_or_subqueryContext, Result_columnContext, Insert_stmtContext, Column_nameContext, Update_stmtContext, Delete_stmtContext, Join_constraintContext, Table_nameContext, Join_operatorContext } from "@wsporto/ts-mysql-parser/dist/sqlite";
import { ColumnDef, FieldName, TraverseContext, TypeAndNullInfer, TypeAndNullInferParam } from "../mysql-query-analyzer/types";
import { filterColumns, findColumn, findColumnSchema, includeColumn, splitName } from "../mysql-query-analyzer/select-columns";
import { createColumnType, freshVar } from "../mysql-query-analyzer/collect-constraints";
import { DeleteResult, InsertResult, QuerySpecificationResult, SelectResult, TraverseResult2, UpdateResult, getOrderByColumns } from "../mysql-query-analyzer/traverse";
import { Relation2 } from "./sqlite-describe-nested-query";

export function traverse_Sql_stmtContext(sql_stmt: Sql_stmtContext, traverseContext: TraverseContext): TraverseResult2 {

    const select_stmt = sql_stmt.select_stmt();
    if (select_stmt) {
        const selectResult = traverse_select_stmt(select_stmt, traverseContext);
        return selectResult;
    }
    const insert_stmt = sql_stmt.insert_stmt();
    if (insert_stmt) {
        const insertResult = traverse_insert_stmt(insert_stmt, traverseContext);
        return insertResult;
    }
    const update_stmt = sql_stmt.update_stmt();
    if (update_stmt) {
        const updateResult = traverse_update_stmt(update_stmt, traverseContext);
        return updateResult;
    }
    const delete_stmt = sql_stmt.delete_stmt();
    if (delete_stmt) {
        const deleteResult = traverse_delete_stmt(delete_stmt, traverseContext);
        return deleteResult;
    }
    throw Error("traverse_Sql_stmtContext");
}

function traverse_select_stmt(select_stmt: Select_stmtContext, traverseContext: TraverseContext, subQuery = false): SelectResult {
    const common_table_stmt = select_stmt.common_table_stmt();
    if (common_table_stmt) {
        const common_table_expression = common_table_stmt.common_table_expression_list()
        common_table_expression.forEach(common_table_expression => {
            const table_name = common_table_expression.table_name();
            const select_stmt = common_table_expression.select_stmt();
            const select_stmt_result = traverse_select_stmt(select_stmt, traverseContext);
            select_stmt_result.columns.forEach(col => {
                traverseContext.withSchema.push({
                    table: table_name.getText(),
                    columnName: col.name,
                    columnType: col.type,
                    columnKey: '',
                    notNull: col.notNull
                });
            })
        })
    }

    const select_coreList = select_stmt.select_core_list();

    const querySpecResult = select_coreList.map(select_core => {
        const columnsResult: ColumnDef[] = [];
        const listType: TypeAndNullInfer[] = [];

        const table_or_subquery = select_core.table_or_subquery_list();
        if (table_or_subquery) {
            const fields = traverse_table_or_subquery(table_or_subquery, null, null, traverseContext);
            columnsResult.push(...fields);
        }
        const join_clause = select_core.join_clause();
        if (join_clause) {
            const join_table_or_subquery = join_clause.table_or_subquery_list();
            const join_constraint_list = join_clause.join_constraint_list();
            const join_operator_list = join_clause.join_operator_list();
            const fields = traverse_table_or_subquery(join_table_or_subquery, join_constraint_list, join_operator_list, traverseContext);
            columnsResult.push(...fields);
        }

        const result_column = select_core.result_column_list();
        const fromColumns = subQuery ? traverseContext.fromColumns.concat(columnsResult) : columnsResult;

        result_column.forEach(result_column => {
            if (result_column.STAR()) {
                const tableName = result_column.table_name()?.getText();
                columnsResult.forEach(col => {
                    if (!tableName || includeColumn(col, tableName)) {
                        const columnType = createColumnType(col);
                        listType.push({
                            name: columnType.name,
                            type: columnType,
                            notNull: col.notNull,
                            table: col.tableAlias || col.table
                        });
                    }

                })
            }

            const expr = result_column.expr();
            const alias = result_column.column_alias()?.getText();
            if (expr) {

                const exprType = traverse_expr(expr, { ...traverseContext, fromColumns: fromColumns });
                if (alias) {
                    traverseContext.relations.filter(relation => relation.joinColumn == exprType.name && (relation.name == exprType.table || relation.alias == exprType.table)).forEach(relation => {
                        relation.joinColumn = alias;
                    });
                }

                if (exprType.type.kind == 'TypeVar') {
                    if (alias) {
                        exprType.name = alias;
                    }
                    listType.push(exprType);
                }
            }
        })

        const whereList = select_core.expr_list();
        whereList.forEach(where => {
            traverse_expr(where, { ...traverseContext, fromColumns: fromColumns });
        })
        const querySpecification: QuerySpecificationResult = {
            columns: listType.map(col => ({
                ...col,
                notNull: col.notNull || isNotNull(col.name, whereList[0])
            })),
            fromColumns: columnsResult //TODO - return isMultipleRowResult instead
        }
        return querySpecification;
    });

    const mainQuery = querySpecResult[0];
    for (let queryIndex = 1; queryIndex < querySpecResult.length; queryIndex++) {//UNION
        const unionQuery = querySpecResult[queryIndex];
        unionQuery.columns.forEach((col, colIndex) => {
            mainQuery.columns[colIndex].table = '';
            traverseContext.constraints.push({
                expression: 'UNION',
                type1: mainQuery.columns[colIndex].type,
                type2: col.type
            })
        })
    }

    const selectResult: SelectResult = {
        queryType: 'Select',
        columns: mainQuery.columns,
        multipleRowsResult: isMultipleRowResult(select_stmt, mainQuery.fromColumns),
        relations: traverseContext.relations
    }
    const order_by_stmt = select_stmt.order_by_stmt();
    let hasOrderByParameter = false;
    if (order_by_stmt) {
        const ordering_term_list = order_by_stmt.ordering_term_list();
        ordering_term_list.forEach(ordering_term => {
            const expr = ordering_term.expr();
            if (expr.getText() == '?') {
                hasOrderByParameter = true;
            }
            // else {
            //     traverse_expr(expr, traverseContext);
            // }
        })
        if (hasOrderByParameter) {
            const orderByColumns = getOrderByColumns(mainQuery.fromColumns, mainQuery.columns);
            selectResult.orderByColumns = orderByColumns;
        }
    }
    const limit = select_stmt.limit_stmt();
    if (limit) {
        const expr_list = limit.expr_list();
        const expr1 = expr_list[0];
        const exrp1Type = traverse_expr(expr1, traverseContext);
        exrp1Type.notNull = true;
        traverseContext.constraints.push({
            expression: expr1.getText(),
            type1: exrp1Type.type,
            type2: freshVar('INTEGER', 'INTEGER')
        })
        if (expr_list.length == 2) {
            const expr2 = expr_list[1];
            const exrp2Type = traverse_expr(expr2, traverseContext);
            exrp2Type.notNull = true;
            traverseContext.constraints.push({
                expression: expr2.getText(),
                type1: exrp2Type.type,
                type2: freshVar('INTEGER', 'INTEGER')
            })
        }
    }

    return selectResult;
}

function traverse_table_or_subquery(
    table_or_subquery_list: Table_or_subqueryContext[],
    join_constraint_list: Join_constraintContext[] | null,
    join_operator_list: Join_operatorContext[] | null,
    traverseContext: TraverseContext): ColumnDef[] {
    const allFields: ColumnDef[] = [];
    table_or_subquery_list.forEach((table_or_subquery, index) => {

        const isLeftJoin = index > 0 && join_operator_list ? join_operator_list[index - 1]?.LEFT_() != null : false;
        const table_name = table_or_subquery.table_name();
        const table_alias_temp = table_or_subquery.table_alias()?.getText() || '';

        //grammar error: select * from table1 inner join table2....; inner is parsed as table_alias
        let table_alias = table_alias_temp.toLowerCase() == 'left'
            || table_alias_temp.toLowerCase() == 'right'
            || table_alias_temp.toLowerCase() == 'full'
            || table_alias_temp.toLowerCase() == 'outer'
            || table_alias_temp.toLowerCase() == 'inner'
            || table_alias_temp.toLowerCase() == 'cross' ? '' : table_alias_temp;

        const join_constraint = join_constraint_list && index > 0 ? join_constraint_list[index - 1] : undefined;

        if (table_name) {
            const tableName = splitName(table_name.any_name().getText());
            const asAlias = table_or_subquery.AS_() || false;
            const fields = filterColumns(traverseContext.dbSchema, traverseContext.withSchema, table_alias, tableName);
            const usingFields = join_constraint?.USING_() ? join_constraint?.column_name_list().map(column_name => column_name.getText()) : [];
            const filteredFields = usingFields.length > 0 ? filterUsingFields(fields, usingFields) : fields;
            if (isLeftJoin) {
                allFields.push(...filteredFields.map(field => ({ ...field, notNull: false })));
            }
            else {
                allFields.push(...filteredFields);
            }

            const idColumn = fields.find(field => field.columnKey == 'PRI')?.columnName!;
            const relation: Relation2 = {
                name: asAlias ? table_alias : tableName.name,
                alias: table_alias,
                parentRelation: '',
                cardinality: 'one',
                joinColumn: idColumn
            }

            if (join_constraint) { //index 0 is the FROM (root relation)
                const expr = join_constraint.expr(); //ON expr
                if (expr) {
                    traverse_expr(expr, { ...traverseContext, fromColumns: allFields });

                    const allJoinColumsn = getAllColumns(expr);
                    allJoinColumsn.forEach(joinColumn => {
                        if (joinColumn.prefix != relation.name && joinColumn.prefix != relation.alias) {
                            relation.parentRelation = joinColumn.prefix;

                        }
                        if (joinColumn.prefix == relation.name || joinColumn.prefix == relation.alias) {
                            // relation.joinColumn = joinColumn.name;
                            const column = allFields.find(col => col.columnName == joinColumn.name && (col.tableAlias == joinColumn.prefix || col.table == joinColumn.prefix))!;
                            if (column?.columnKey != 'UNI' && column?.columnKey != 'PRI') {
                                relation.cardinality = 'many'
                            }
                        }
                    })
                }
            }
            traverseContext.relations.push(relation);
        }
        const select_stmt = table_or_subquery.select_stmt();
        if (select_stmt) {
            const subQueryResult = traverse_select_stmt(select_stmt, traverseContext);
            const tableAlias = table_or_subquery.table_alias()?.getText();
            subQueryResult.columns.forEach(t => {
                const colDef: ColumnDef = {
                    table: t.table ? tableAlias || '' : '',
                    columnName: t.name,
                    columnType: t.type,
                    columnKey: "",
                    notNull: t.notNull,
                    tableAlias: tableAlias
                }
                allFields.push(colDef);
            })
        }
        const table_or_subquery_list = table_or_subquery.table_or_subquery_list();
        if (table_or_subquery_list.length > 0) {
            const fields = traverse_table_or_subquery(table_or_subquery_list, null, null, traverseContext);
            allFields.push(...fields);
        }
    })
    return allFields;
}

function traverse_expr(expr: ExprContext, traverseContext: TraverseContext): TypeAndNullInfer {
    const function_name = expr.function_name()?.getText().toLowerCase();
    if (function_name == 'avg') {
        const functionType = freshVar(expr.getText(), 'REAL');
        const sumParamExpr = expr.expr(0);
        const paramType = traverse_expr(sumParamExpr, traverseContext);
        if (paramType.type.kind == 'TypeVar') {
            functionType.table = paramType.table
        }
        return {
            name: functionType.name,
            type: functionType,
            notNull: paramType.notNull,
            table: functionType.table || ''
        };
    }
    if (function_name == 'sum') {
        const functionType = freshVar(expr.getText(), 'INTEGER');
        const sumParamExpr = expr.expr(0);
        const paramType = traverse_expr(sumParamExpr, traverseContext);
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: functionType,
            type2: paramType.type,
            mostGeneralType: true
        })

        return {
            name: expr.getText(),
            type: functionType,
            notNull: false,
            table: paramType.table || ''
        };
    }
    if (function_name == 'min' || function_name == 'max') {
        const functionType = freshVar(expr.getText(), '?');
        const sumParamExpr = expr.expr(0);
        const paramType = traverse_expr(sumParamExpr, traverseContext);
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: functionType,
            type2: paramType.type
        })
        return {
            name: functionType.name,
            type: functionType,
            notNull: paramType.notNull,
            table: functionType.table || ''
        };
    }
    if (function_name == 'count') {
        const functionType = freshVar(expr.getText(), 'INTEGER');
        if (expr.expr_list().length == 1) {
            const sumParamExpr = expr.expr(0);
            const paramType = traverse_expr(sumParamExpr, traverseContext);
            if (paramType.type.kind == 'TypeVar') {
                functionType.table = paramType.table
            }
        }

        return {
            name: functionType.name,
            type: functionType,
            notNull: true,
            table: functionType.table || ''
        };
    }
    if (function_name == 'concat') {
        const functionType = freshVar(expr.getText(), 'TEXT');
        expr.expr_list().forEach(paramExpr => {
            const paramType = traverse_expr(paramExpr, traverseContext);
            traverseContext.constraints.push({
                expression: expr.getText(),
                type1: functionType,
                type2: paramType.type
            })
            if (paramType.type.kind == 'TypeVar') {
                functionType.table = paramType.table
            }
        });

        return {
            name: functionType.name,
            type: functionType,
            notNull: true,
            table: functionType.table || ''
        };
    }
    if (function_name == 'coalesce') {
        const functionType = freshVar(expr.getText(), '?');
        const paramTypes = expr.expr_list().map(paramExpr => {
            const paramType = traverse_expr(paramExpr, traverseContext);
            traverseContext.constraints.push({
                expression: expr.getText(),
                type1: functionType,
                type2: paramType.type
            })
            return paramType;
        });
        return {
            name: functionType.name,
            type: functionType,
            notNull: paramTypes.some(param => param.notNull),
            table: functionType.table || ''
        };
    }
    if (function_name == 'strftime') {
        const functionType = freshVar(expr.getText(), 'TEXT');
        const paramExpr = expr.expr(1);
        const paramType = traverse_expr(paramExpr, traverseContext);
        paramType.notNull = true;
        traverseContext.constraints.push({
            expression: paramExpr.getText(),
            type1: freshVar(paramExpr.getText(), 'DATE'),
            type2: paramType.type
        })
        return {
            name: functionType.name,
            type: functionType,
            notNull: false,
            table: functionType.table || ''
        };
    }
    if (function_name == 'date' || function_name == 'time' || function_name == 'datetime') {
        const functionType = freshVar(expr.getText(), 'TEXT');
        const paramExpr = expr.expr(0);
        const paramType = traverse_expr(paramExpr, traverseContext);
        paramType.notNull = true;
        traverseContext.constraints.push({
            expression: paramExpr.getText(),
            type1: freshVar(paramExpr.getText(), 'DATE'),
            type2: paramType.type
        })
        return {
            name: functionType.name,
            type: functionType,
            notNull: false,
            table: functionType.table || ''
        };
    }
    if (function_name == 'ifnull') {
        const functionType = freshVar(expr.getText(), '?');
        const paramTypes = expr.expr_list().map(paramExpr => {
            const paramType = traverse_expr(paramExpr, traverseContext);
            if (paramType.name == '?') {
                paramType.notNull = false;
            }
            traverseContext.constraints.push({
                expression: expr.getText(),
                type1: functionType,
                type2: paramType.type
            })
            return paramType;
        })
        return {
            name: functionType.name,
            type: functionType,
            notNull: paramTypes.every(param => param.notNull),
            table: functionType.table || ''
        };
    }
    if (function_name) {
        throw Error('traverse_expr: function not supported:' + function_name);
    }

    const column_name = expr.column_name();
    const table_name = expr.table_name();
    if (column_name) {
        const type = traverse_column_name(column_name, table_name, traverseContext);
        return type;
    }
    const literal = expr.literal_value();
    if (literal) {
        if (literal.STRING_LITERAL()) {
            const type = freshVar(literal.getText(), 'TEXT')
            return {
                name: type.name,
                type: type,
                notNull: true,
                table: type.table || ''
            };
        }
        if (literal.NUMERIC_LITERAL()) {
            const type = freshVar(literal.getText(), 'INTEGER');
            return {
                name: type.name,
                type: type,
                notNull: true,
                table: type.table || ''
            };
        }
        const type = freshVar(literal.getText(), '?');
        return {
            name: type.name,
            type: type,
            notNull: true,
            table: type.table || ''
        };
    }
    const parameter = expr.BIND_PARAMETER();
    if (parameter) {
        const param = freshVar('?', '?');
        const type: TypeAndNullInferParam = {
            name: param.name,
            type: param,
            notNull: false,
            table: param.table || '',
            paramIndex: parameter.symbol.tokenIndex
        };
        traverseContext.parameters.push(type);
        return type;

    }
    if (expr.STAR() || expr.DIV() || expr.MOD()) {
        const exprLeft = expr.expr(0);
        const exprRight = expr.expr(1);
        const typeLeft = traverse_expr(exprLeft, traverseContext);
        const typeRight = traverse_expr(exprRight, traverseContext);
        const type = freshVar(expr.getText(), '?');
        return {
            name: type.name,
            type: type,
            notNull: typeLeft.notNull && typeRight.notNull,
            table: type.table || ''
        };
    }
    if (expr.PLUS() || expr.MINUS()) {
        const returnType = freshVar(expr.getText(), 'REAL');
        const exprLeft = expr.expr(0);
        const exprRight = expr.expr(1);
        const typeLeft = traverse_expr(exprLeft, traverseContext);
        const typeRight = traverse_expr(exprRight, traverseContext);
        traverseContext.constraints.push({
            expression: exprLeft.getText(),
            type1: returnType,
            type2: typeLeft.type
        })
        traverseContext.constraints.push({
            expression: exprRight.getText(),
            type1: returnType,
            type2: typeRight.type
        })
        return {
            ...typeRight,
            notNull: typeLeft.notNull && typeRight.notNull
        };
    }
    if (expr.LT2() || expr.GT2() || expr.AMP() || expr.PIPE() || expr.LT() || expr.LT_EQ() || expr.GT() || expr.GT_EQ()) {
        const exprLeft = expr.expr(0);
        const exprRight = expr.expr(1);
        const typeLeft = traverse_expr(exprLeft, traverseContext);
        const typeRight = traverse_expr(exprRight, traverseContext);
        if (typeLeft.name == '?') {
            typeLeft.notNull = true;
        }
        if (typeRight.name == '?') {
            typeRight.notNull = true;
        }
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: typeLeft.type,
            type2: typeRight.type
        })
        const type = freshVar(expr.getText(), '?');
        return {
            name: type.name,
            type: type,
            notNull: true,
            table: type.table || ''
        };
    }
    if (expr.IS_()) { //is null/is not null
        const expr_ = expr.expr(0);
        traverse_expr(expr_, traverseContext);
        const type = freshVar(expr.getText(), 'INTEGER');
        return {
            name: type.name,
            type: type,
            notNull: true,
            table: type.table || ''
        };
    }
    if (expr.ASSIGN()) { //=
        const exprLeft = expr.expr(0);
        const exprRight = expr.expr(1);
        const typeLeft = traverse_expr(exprLeft, traverseContext);
        const typeRight = traverse_expr(exprRight, traverseContext);
        if (typeLeft.name == '?') {
            typeLeft.notNull = true;
        }
        if (typeRight.name == '?') {
            typeRight.notNull = true;
        }

        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: typeLeft.type,
            type2: typeRight.type
        })
        const type = freshVar(expr.getText(), '?');
        return {
            name: type.name,
            type: type,
            notNull: true,
            table: type.table || ''
        };
    }
    if (expr.BETWEEN_()) {
        const exprType = traverse_expr(expr.expr(0), traverseContext);
        const between1 = traverse_expr(expr.expr(1), traverseContext);
        const between2 = traverse_expr(expr.expr(2), traverseContext);
        if (between1.name == '?') {
            between1.notNull = true;
        }
        if (between2.name == '?') {
            between2.notNull = true;
        }
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: exprType.type,
            type2: between1.type
        });
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: exprType.type,
            type2: between2.type
        });
        traverseContext.constraints.push({
            expression: expr.getText(),
            type1: between1.type,
            type2: between2.type
        })
        return exprType;
    }
    if (expr.OR_() || expr.AND_()) {
        const expr1 = expr.expr(0);
        const expr2 = expr.expr(1);
        traverse_expr(expr1, traverseContext);
        return traverse_expr(expr2, traverseContext);
    }
    if (expr.IN_()) {
        const inExprLeft = expr.expr(0);
        const inExprRight = expr.expr(1);
        const typeLeft = traverse_expr(inExprLeft, traverseContext);
        inExprRight.children?.forEach(exprRight => {
            if (exprRight instanceof ExprContext) {
                const typeRight = traverse_expr(exprRight, traverseContext);
                traverseContext.constraints.push({
                    expression: expr.getText(),
                    type1: typeLeft.type,
                    type2: typeRight.type
                })
            }
        })
        const type = freshVar(expr.getText(), '?');
        return {
            name: type.name,
            type: type,
            notNull: true,
            table: type.table || ''
        };
    }
    const select_stmt = expr.select_stmt();
    if (select_stmt) {
        const subQueryType = traverse_select_stmt(select_stmt, traverseContext, true);
        const type = { ...subQueryType.columns[0].type, table: '' };
        return {
            name: type.name,
            type: type,
            notNull: subQueryType.columns[0].notNull,
            table: type.table || ''
        };
    }
    if (expr.OPEN_PAR() && expr.CLOSE_PAR()) {
        const type = freshVar(expr.getText(), '?');
        const exprTypes = expr.expr_list().map(innerExpr => {
            const exprType = traverse_expr(innerExpr, traverseContext);
            traverseContext.constraints.push({
                expression: innerExpr.getText(),
                type1: exprType.type,
                type2: type
            })
            return exprType;
        });
        return {
            name: type.name,
            type: type,
            notNull: exprTypes.every(type => type.notNull),
            table: type.table || ''
        };
    }

    if (expr.CASE_()) {
        const resultTypes: TypeAndNullInfer[] = []; //then and else
        const whenTypes: TypeAndNullInfer[] = [];
        expr.expr_list().forEach((expr_, index) => {
            const type = traverse_expr(expr_, traverseContext);
            if (index % 2 == 0 && (!expr.ELSE_() || index < expr.expr_list().length - 1)) {
                whenTypes.push(type);
            }
            else {
                resultTypes.push(type);
            }
        });
        resultTypes.forEach((resultType, index) => {
            if (index > 0) {
                traverseContext.constraints.push({
                    expression: expr.getText(),
                    type1: resultTypes[0].type,
                    type2: resultType.type
                })
            }
        });
        whenTypes.forEach((whenType) => {
            traverseContext.constraints.push({
                expression: expr.getText(),
                type1: freshVar('INTEGER', 'INTEGER'),
                type2: whenType.type
            })
        });
        const type = resultTypes[0];
        return {
            name: extractOriginalSql(expr),
            type: type.type,
            notNull: expr.ELSE_() ? resultTypes.every(type => type.notNull) : false,
            table: type.table || ''
        };
    }
    throw Error('traverse_expr not supported:' + expr.getText());
}

function extractOriginalSql(rule: ExprContext) {

    const startIndex = rule.start.start;
    const stopIndex = rule.stop?.stop || startIndex;
    const result = rule.start.getInputStream()?.getText(startIndex, stopIndex);
    return result;
}

function traverse_column_name(column_name: Column_nameContext, table_name: Table_nameContext | null, traverseContext: TraverseContext): TypeAndNullInfer {
    const fieldName: FieldName = { name: column_name.getText(), prefix: table_name?.getText() || '' }
    const column = findColumn(fieldName, traverseContext.fromColumns);
    const typeVar = freshVar(column.columnName, column.columnType.type, column.tableAlias || column.table);
    return {
        name: typeVar.name,
        type: typeVar,
        table: column.tableAlias || column.table,
        notNull: column.notNull
    };
}

export function isNotNull(columnName: string, where: ExprContext | null): boolean {
    if (where == null) {
        return false;
    }
    if (where.AND_()) {
        const ifNullList = where.expr_list().map(expr => isNotNull(columnName, expr));
        const result = ifNullList.some(v => v);
        return result;
    }
    else if (where.OR_()) {
        const possibleNullList = where.expr_list().map(expr => isNotNull(columnName, expr))
        const result = possibleNullList.every(v => v)
        return result;
    }
    else {
        return isNotNullExpr(columnName, where);
    }
}

function isNotNullExpr(columnName: string, expr: ExprContext): boolean {
    if (expr.OPEN_PAR() && expr.CLOSE_PAR()) {
        const innerExpr = expr.expr(0);
        return isNotNull(columnName, innerExpr);
    }
    if (expr.ASSIGN()
        || expr.GT()
        || (expr.IS_() && expr.expr_list().length == 2 && expr.expr(1).getText() == 'notnull')) {
        const exprLeft = expr.expr(0);
        const exprRight = expr.expr(1);
        const column_name_left = exprLeft.column_name();
        const column_name_right = exprRight.column_name();
        if (column_name_left || column_name_right) {
            const columnLeft = column_name_left?.getText();
            const columnRight = column_name_right?.getText();
            if (columnLeft == columnName || columnRight == columnName) {
                return true;
            }
        }
    }
    return false;
}

export function isMultipleRowResult(select_stmt: Select_stmtContext, fromColumns: ColumnDef[]) {
    if (select_stmt.select_core_list().length == 1) { //UNION queries are multipleRowsResult = true
        const select_core = select_stmt.select_core(0);
        const from = select_core.FROM_();
        if (!from) {
            return false;
        }
        const groupBy = select_stmt.select_core_list().some(select_core => select_core.GROUP_() != null);
        if (groupBy) {
            return true;
        }
        const agreegateFunction = select_core.result_column_list().every(result_column => isAgregateFunction(result_column));
        if (agreegateFunction) {
            return false;
        }
        const _whereExpr = select_core._whereExpr;
        const isSingleResult = select_core.join_clause() == null && _whereExpr && where_is_single_result(_whereExpr, fromColumns);
        if (isSingleResult == true) {
            return false;
        }
    }
    if (isLimitOne(select_stmt)) {
        return false;
    }

    return true;
}

function isAgregateFunction(result_column: Result_columnContext) {
    const function_name = result_column.expr()?.function_name()?.getText().toLowerCase();
    return function_name == 'count'
        || function_name == 'sum'
        || function_name == 'avg'
        || function_name == 'min'
        || function_name == 'max';
}

function isLimitOne(select_stmt: Select_stmtContext) {

    const limit_stmt = select_stmt.limit_stmt();
    if (limit_stmt && limit_stmt.expr(0).getText() == '1') {
        return true;
    }
    return false;
}

function where_is_single_result(whereExpr: ExprContext, fromColumns: ColumnDef[]): boolean {
    if (whereExpr.ASSIGN()) {
        const isSingleResult = is_single_result(whereExpr, fromColumns);
        return isSingleResult;
    }
    const expr_list = whereExpr.expr_list();
    const onlyAnd = !whereExpr.OR_();
    const oneSingle = expr_list.some(expr => is_single_result(expr, fromColumns));
    if (onlyAnd && oneSingle) {
        return true;
    }
    return false;
}

function is_single_result(expr: ExprContext, fromColumns: ColumnDef[]): boolean {
    const expr1 = expr.expr(0);
    const expr2 = expr.expr(1); //TODO: 1 = id
    const column_name = expr1?.column_name();
    if (column_name && expr.ASSIGN()) {
        const fieldName = splitName(column_name.getText());
        const column = findColumn(fieldName, fromColumns);
        if (column.columnKey == 'PRI') {
            return true;
        }
    }
    return false;
}

function traverse_insert_stmt(insert_stmt: Insert_stmtContext, traverseContext: TraverseContext): InsertResult {
    const table_name = insert_stmt.table_name();
    const fromColumns = filterColumns(traverseContext.dbSchema, [], '', splitName(table_name.getText()));
    const columns = insert_stmt.column_name_list().map(column_name => {
        return traverse_column_name(column_name, null, { ...traverseContext, fromColumns });
    });
    const insertColumns: TypeAndNullInfer[] = [];
    const value_row_list = insert_stmt.values_clause()?.value_row_list() || [];
    value_row_list.forEach((value_row) => {
        value_row.expr_list().forEach((expr, index) => {
            const numberParamsBefore = traverseContext.parameters.length;
            const exprType = traverse_expr(expr, traverseContext);
            traverseContext.parameters.slice(numberParamsBefore).forEach((param) => {
                const col = columns[index];
                traverseContext.constraints.unshift({
                    expression: expr.getText(),
                    type1: col.type,
                    type2: exprType.type
                });
                insertColumns.push({
                    ...param,
                    notNull: exprType.name == '?' ? col.notNull : param.notNull
                })
            })
        });
    })
    const select_stmt = insert_stmt.select_stmt();
    if (select_stmt) {
        const columnNullability = new Map<string, boolean>();
        const selectResult = traverse_select_stmt(select_stmt, traverseContext);
        selectResult.columns.forEach((selectColumn, index) => {
            const col = columns[index];
            traverseContext.constraints.unshift({
                expression: col.name,
                type1: col.type,
                type2: selectColumn.type
            });
            columnNullability.set(selectColumn.type.id, col.notNull);
        })

        traverseContext.parameters.forEach(param => {

            insertColumns.push({
                ...param,
                notNull: columnNullability.get(param.type.id) != null ? columnNullability.get(param.type.id)! : param.notNull
            })
        })
    }

    const queryResult: InsertResult = {
        queryType: 'Insert',
        columns: insertColumns
    }
    return queryResult;
}

function traverse_update_stmt(update_stmt: Update_stmtContext, traverseContext: TraverseContext): UpdateResult {
    const table_name = update_stmt.qualified_table_name().getText();
    const fromColumns = filterColumns(traverseContext.dbSchema, [], '', splitName(table_name));

    const column_name_list = Array.from({ length: update_stmt.ASSIGN_list().length })
        .map((_, i) => update_stmt.column_name(i));
    const columns = column_name_list.map(column_name => {
        return traverse_column_name(column_name, null, { ...traverseContext, fromColumns });
    });
    const updateColumns: TypeAndNullInfer[] = [];
    const whereParams: TypeAndNullInfer[] = [];
    const expr_list = update_stmt.expr_list();
    let paramsBefore = traverseContext.parameters.length;
    expr_list.forEach((expr, index) => {
        paramsBefore = traverseContext.parameters.length;
        const exprType = traverse_expr(expr, { ...traverseContext, fromColumns });
        if (!update_stmt.WHERE_() || expr.start.start < update_stmt.WHERE_().symbol.start) {

            const col = columns[index];
            traverseContext.constraints.push({
                expression: expr.getText(),
                type1: col.type,
                type2: exprType.type
            });
            traverseContext.parameters.slice(paramsBefore).forEach((param, index) => {
                updateColumns.push({
                    ...param,
                    notNull: param.notNull && col.notNull
                })
            });
        }
        else {
            traverseContext.parameters.slice(paramsBefore).forEach((param, index) => {
                whereParams.push(param)
            });
        }
    });

    const queryResult: UpdateResult = {
        queryType: 'Update',
        columns: updateColumns,
        params: whereParams
    }
    return queryResult;
}

function traverse_delete_stmt(delete_stmt: Delete_stmtContext, traverseContext: TraverseContext): DeleteResult {
    const table_name = delete_stmt.qualified_table_name().getText();
    const fromColumns = filterColumns(traverseContext.dbSchema, [], '', splitName(table_name));

    const expr = delete_stmt.expr();
    traverse_expr(expr, { ...traverseContext, fromColumns });

    const queryResult: DeleteResult = {
        queryType: 'Delete',
        params: traverseContext.parameters
    }
    return queryResult;
}

function getAllColumns(expr: ExprContext): FieldName[] {
    const columns: FieldName[] = [];
    if (expr.ASSIGN()) {
        const expr1 = expr.expr(0);
        const expr2 = expr.expr(1);
        columns.push(splitName(expr1.getText()));
        columns.push(splitName(expr2.getText()));
    };
    return columns;
}

function filterUsingFields(fields: ColumnDef[], usingFields: string[]) {
    const result = fields.filter(field => !usingFields.includes(field.columnName));
    return result;
}
