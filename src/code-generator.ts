import { SchemaDef, CamelCaseName, TsFieldDescriptor, ParameterDef } from "./types";
import fs from "fs";
import path, { parse } from "path";
import { DbClient } from "./queryExectutor";
import camelCase from "camelcase";
import { isLeft } from "fp-ts/lib/Either";
import { none, Option, some, isNone } from "fp-ts/lib/Option";
import { converToTsType, MySqlType } from "./mysql-mapping";
import { parseSql } from "./describe-query";
import CodeBlockWriter from "code-block-writer";
import { NestedTsDescriptor, createNestedTsDescriptor } from "./ts-nested-descriptor";

export function generateTsCode(tsDescriptor: TsDescriptor, fileName: string, target: 'node' | 'deno', crud: boolean = false): string {
    const writer = new CodeBlockWriter();

    const camelCaseName = convertToCamelCaseName(fileName);
    const capitalizedName = capitalize(camelCaseName);

    const dataTypeName = capitalizedName + 'Data';
    const paramsTypeName = capitalizedName + 'Params';
    const resultTypeName = capitalizedName + 'Result';
    const orderByTypeName = capitalizedName + 'OrderBy';
    const generateOrderBy = tsDescriptor.orderByColumns != null && tsDescriptor.orderByColumns.length > 0;

    // Import declarations
    if (target == 'deno') {
        writer.writeLine(`import { Client } from "https://deno.land/x/mysql/mod.ts";`);
    }
    else {
        writer.writeLine(`import type { Connection } from 'mysql2/promise';`);
    }
    writer.blankLine();

    if (tsDescriptor.data) { //update
        writeTypeBlock(writer, tsDescriptor.data, dataTypeName, crud);
    }

    const orderByField = generateOrderBy ? `orderBy: [${orderByTypeName}, ...${orderByTypeName}[]]` : undefined;
    writeTypeBlock(writer, tsDescriptor.parameters, paramsTypeName, false, orderByField);
    writeTypeBlock(writer, tsDescriptor.columns, resultTypeName, false)

    let functionReturnType = resultTypeName;
    functionReturnType += tsDescriptor.multipleRowsResult ? '[]' : tsDescriptor.queryType == 'Select' ? ' | null' : '';

    let functionArguments = target == 'deno' ? 'client: Client' : 'connection: Connection';
    functionArguments += tsDescriptor.data && tsDescriptor.data.length > 0 ? ', data: ' + dataTypeName : '';
    functionArguments += tsDescriptor.parameters.length > 0 || generateOrderBy ? ', params: ' + paramsTypeName : '';

    const allParameters = tsDescriptor.data ? tsDescriptor.data.map((field, index) => {
        //:nameIsSet, :name, :valueIsSet, :value....
        if (crud && index % 2 == 0) {
            const nextField = tsDescriptor.data![index + 1];
            return `data.${nextField.name} !== undefined`;
        }
        return 'data.' + field.name;
    }) : [];
    allParameters.push(...tsDescriptor.parameterNames.map((paramName) => generateParam(target, paramName)));

    const queryParams = allParameters.length > 0 ? ', [' + allParameters.join(', ') + ']' : '';

    const escapedBackstick = scapeBackStick(tsDescriptor.sql);
    const processedSql = replaceOrderByParam(escapedBackstick);
    const sqlSplit = processedSql.split('\n');

    writer.write(`export async function ${camelCaseName}(${functionArguments}) : Promise<${functionReturnType}>`).block(() => {
        writer.writeLine('const sql = `');
        sqlSplit.forEach(sqlLine => {
            writer.indent().write(sqlLine);
            writer.newLine();
        });
        writer.indent().write('`');
        writer.blankLine();
        const singleRowSelect = tsDescriptor.queryType == 'Select' && tsDescriptor.multipleRowsResult === false;
        if (target == 'deno') {
            writer.writeLine(`return client.query(sql${queryParams})`);
            writer.indent().write(`.then(res => res${singleRowSelect ? '[0]' : ''});`);
        }
        else {
            if (tsDescriptor.queryType == 'Select') {
                writer.writeLine(`return connection.query({sql, rowsAsArray: true}${queryParams})`);
                writer.indent().write(`.then(res => res[0] as any[])`);
                writer.newLine().indent().write(`.then(res => res.map(data => mapArrayTo${resultTypeName}(data)))`);
            }
            else {
                writer.writeLine(`return connection.query(sql${queryParams})`);
                writer.indent().write(`.then(res => res[0] as ${resultTypeName})`);
            }
            if (tsDescriptor.queryType == 'Select' && tsDescriptor.multipleRowsResult == false) {
                writer.newLine().indent().write(`.then(res => res[0]);`);
            }
            else {
                writer.write(';');
            }
        }
    })
    if (target == 'node' && tsDescriptor.queryType == 'Select') {
        writer.blankLine();
        writer.write(`function mapArrayTo${resultTypeName}(data: any)`).block(() => {
            writer.write(`const result: ${resultTypeName} =`).block(() => {
                tsDescriptor.columns.forEach((tsField, index) => {
                    writer.writeLine(`${tsField.name}: data[${index}]${commaSeparator(tsDescriptor.columns.length, index)}`);
                })
            });
            writer.write('return result;');
        })
    }

    if (generateOrderBy) {
        const orderByColumnsType = tsDescriptor.orderByColumns?.map(col => `"${col}"`).join(' | ');
        writer.blankLine();
        writer.write(`export type ${orderByTypeName} = `).block(() => {
            writer.writeLine(`column: ${orderByColumnsType};`);
            writer.writeLine(`direction: 'asc' | 'desc';`);
        })
        writer.blankLine();
        writer.write(`function escapeOrderBy(orderBy: ${orderByTypeName}[]) : string`).block(() => {
            writer.writeLine(`return orderBy.map( order => \`\\\`\${order.column}\\\` \${order.direction == 'desc' ? 'desc' : 'asc' }\`).join(', ');`);
        })
    }

    if (tsDescriptor.nestedDescriptor) {
        const relations = tsDescriptor.nestedDescriptor.relations;
        relations.forEach((relation) => {
            const relationType = generateRelationType(capitalizedName, relation.name);
            writer.blankLine();
            writer.write(`export type ${relationType} = `).block(() => {
                const uniqueNameFields = renameInvalidNames(relation.fields.map(f => f.name));
                relation.fields.forEach((field, index) => {
                    if (field.type == 'field') {
                        writer.writeLine(`${uniqueNameFields[index]}: ${field.tsType};`);
                    }
                    if (field.type == 'relation') {
                        const nestedRelationType = generateRelationType(capitalizedName, field.tsType);
                        const nullableOperator = field.notNull ? '' : '?'
                        writer.writeLine(`${field.name}${nullableOperator}: ${nestedRelationType};`);
                    }
                })
            })
        })
        relations.forEach((relation, index) => {
            const relationType = generateRelationType(capitalizedName, relation.name);
            if (index == 0) { //first
                writer.blankLine();
                writer.write(`export async function ${camelCaseName}Nested(${functionArguments}): Promise<${relationType}[]>`).block(() => {
                    const params = tsDescriptor.parameters.length > 0 ? ', params' : '';
                    writer.writeLine(`const selectResult = await ${camelCaseName}(connection${params});`);
                    writer.write('if (selectResult.length == 0)').block(() => {
                        writer.writeLine('return [];')
                    });
                    writer.writeLine(`return collect${relationType}(selectResult);`)
                })
            }
            const collectFunctionName = `collect${relationType}`;
            const mapFunctionName = `mapTo${relationType}`;
            writer.blankLine();
            writer.write(`function ${collectFunctionName}(selectResult: ${resultTypeName}[]): ${relationType}[]`).block(() => {
                const groupKey = tsDescriptor.columns[relation.groupKeyIndex].name;
                writer.writeLine(`const grouped = groupBy(selectResult.filter(r => r.${groupKey} != null), r => r.${groupKey});`)
                writer.writeLine(`return [...grouped.values()].map(r => ${mapFunctionName}(r))`)
            })
            writer.blankLine();
            writer.write(`function ${mapFunctionName}(selectResult: ${resultTypeName}[]): ${relationType}`).block(() => {
                writer.writeLine(`const firstRow = selectResult[0];`)
                writer.write(`const result: ${relationType} = `).block(() => {
                    const uniqueNameFields = renameInvalidNames(relation.fields.map(f => f.name));
                    relation.fields.forEach((field, index) => {
                        const separator = commaSeparator(relation.fields.length, index);
                        if (field.type == 'field') {
                            const fieldName = tsDescriptor.columns[field.index].name;
                            writer.writeLine(`${uniqueNameFields[index]}: firstRow.${fieldName}!` + separator);
                        }
                        if (field.type == 'relation') {
                            const nestedRelationType = generateRelationType(capitalizedName, field.name);
                            const cardinality = field.list ? '' : '[0]';
                            writer.writeLine(`${field.name}: collect${nestedRelationType}(selectResult)${cardinality}` + separator);
                        }
                    })
                })
                writer.writeLine('return result;')
            })
        })
        writer.blankLine();
        writer.write('const groupBy = <T, Q>(array: T[], predicate: (value: T, index: number, array: T[]) => Q) =>').block(() => {
            writer.write('return array.reduce((map, value, index, array) => ').inlineBlock(() => {
                writer.writeLine('const key = predicate(value, index, array);');
                writer.writeLine('map.get(key)?.push(value) ?? map.set(key, [value]);');
                writer.writeLine('return map;');
            }).write(', new Map<Q, T[]>());');
        })
    }

    return writer.toString();
}

function generateParam(target: 'node' | 'deno', param: ParamInfo) {
    if (target == 'node' && param.isList) {
        return `params.${param.name}.length == 0? null : params.${param.name}`
    }
    return `params.${param.name}`;
}

function generateRelationType(capitalizedName: string, relationName: string) {
    return capitalizedName + 'Nested' + capitalizeStr(relationName);
}

function writeTypeBlock(writer: CodeBlockWriter, fields: TsFieldDescriptor[], typeName: string, updateCrud: boolean, extraField?: string) {
    const writeBlockCond = fields.length > 0 || extraField != null;
    if (writeBlockCond) {
        writer.write(`export type ${typeName} =`).block(() => {
            fields.forEach((tsField, index) => {
                // :nameSet, :name, valueSet, :value...
                if (updateCrud && index % 2 != 0) {//only odd fields (:name, :value)
                    writer.writeLine(tsFieldToStr(tsField, true) + ';');
                }
                else if (!updateCrud) {
                    writer.writeLine(tsFieldToStr(tsField, false) + ';');
                }
            })
            if (extraField) {
                writer.write(extraField + ';')
            }
        });
        writer.blankLine();
    }

}

function tsFieldToStr(tsField: TsFieldDescriptor, isCrudUpdate: boolean) {
    if (isCrudUpdate) {
        //all fields are optionals
        return tsField.name + '?: ' + tsField.tsType + (tsField.notNull == false ? ' | null' : '');
    }
    return tsField.name + (tsField.notNull ? ': ' : '?: ') + tsField.tsType;
}

export function generateTsDescriptor(queryInfo: SchemaDef): TsDescriptor {

    const escapedColumnsNames = renameInvalidNames(queryInfo.columns.map(col => col.columnName));
    const columns = queryInfo.columns.map((col, columnIndex) => {
        const tsDesc: TsFieldDescriptor = {
            name: escapedColumnsNames[columnIndex],
            tsType: mapColumnType(col.type),
            notNull: col.notNull ? col.notNull : false
        }
        return tsDesc;
    })
    const parameterNames = queryInfo.parameters.map(p => {
        const paramInfo: ParamInfo = {
            name: p.name,
            isList: p.columnType.endsWith('[]') ? true : false
        }
        return paramInfo;
    });
    const uniqueParams = removeDuplicatedParameters(queryInfo.parameters);
    const escapedParametersNames = renameInvalidNames(uniqueParams.map(col => col.name));
    const parameters = uniqueParams.map((col, paramIndex) => {
        const arraySymbol = col.list ? '[]' : '';

        const tsDesc: TsFieldDescriptor = {
            name: escapedParametersNames[paramIndex],
            tsType: mapColumnType(col.columnType) + arraySymbol,
            notNull: col.notNull ? col.notNull : false
        }
        return tsDesc;
    })

    const escapedDataNames = queryInfo.data ? renameInvalidNames(queryInfo.data.map(col => col.name)) : [];
    const data = queryInfo.data?.map((col, dataIndex) => {

        const tsDesc: TsFieldDescriptor = {
            name: escapedDataNames[dataIndex],
            tsType: mapColumnType(col.columnType),
            notNull: col.notNull ? col.notNull : false
        }
        return tsDesc;
    })

    const result: TsDescriptor = {
        sql: queryInfo.sql,
        queryType: queryInfo.queryType,
        multipleRowsResult: queryInfo.multipleRowsResult,
        columns,
        orderByColumns: queryInfo.orderByColumns,
        parameterNames,
        parameters,
        data,
    };
    if (queryInfo.nestedResultInfo) {
        const nestedDescriptor = createNestedTsDescriptor(queryInfo.columns, queryInfo.nestedResultInfo);
        result.nestedDescriptor = nestedDescriptor;
    }
    return result;
}

export function removeDuplicatedParameters(parameters: ParameterDef[]): ParameterDef[] {
    const columnsCount: Map<string, ParameterDef> = new Map();
    parameters.forEach(param => {
        const dupParam = columnsCount.get(param.name);
        if (dupParam != null) { //duplicated - two parameter null and notNull, resturn the null param (notNull == false)
            if (param.notNull == false) {
                columnsCount.set(param.name, param);
            }
            // return param;
        }
        else {
            columnsCount.set(param.name, param);
        }
    })
    return [...columnsCount.values()];
}

export function renameInvalidNames(columnNames: string[]): string[] {
    const columnsCount: Map<string, number> = new Map();
    return columnNames.map(columnName => {
        if (columnsCount.has(columnName)) {
            const count = columnsCount.get(columnName)! + 1;
            columnsCount.set(columnName, count);
            const newName = columnName + '_' + count;
            return escapeInvalidTsField(newName);

        }
        else {
            columnsCount.set(columnName, 1);
            return escapeInvalidTsField(columnName);
        }
    })
}

function scapeBackStick(sql: string) {
    const pattern = /`/g;
    return sql.replace(pattern, "\\`");
}

export function escapeInvalidTsField(columnName: string) {
    const validPattern = /^[a-zA-Z0-9_$]+$/g;
    if (!validPattern.test(columnName)) {
        return `"${columnName}"`;
    }
    return columnName;
}

function mapColumnType(columnType: MySqlType | MySqlType[] | 'any'): string {
    if (columnType == 'any') return 'any';
    const types = ([] as MySqlType[]).concat(columnType);
    const mappedTypes = types.map(type => converToTsType(type));
    return mappedTypes.join(' | '); // number | string

}

function generateTsContent(tsDescriptorOption: Option<TsDescriptor>, queryName: string, target: 'node' | 'deno', crud: boolean) {

    if (isNone(tsDescriptorOption)) {
        return '//Invalid sql';
    }
    return generateTsCode(tsDescriptorOption.value, queryName, target, crud);
}

export function replaceOrderByParam(sql: string) {
    const patern = /(.*order\s+by\s*)(\?)(.\n$)*/i;
    const newSql = sql.replace(patern, "$1${escapeOrderBy(params.orderBy)}$3");
    return newSql;
}

export function writeFile(filePath: string, tsContent: string) {
    fs.writeFileSync(filePath, tsContent);
}

function capitalize(name: CamelCaseName) {
    return capitalizeStr(name);
}

function capitalizeStr(name: string) {
    if (name.length == 0) return name;
    return name.charAt(0).toUpperCase() + name.slice(1);
}

export function convertToCamelCaseName(name: string): CamelCaseName {
    const camelCaseStr = camelCase(name) as CamelCaseName;
    return camelCaseStr;
}

//TODO - pass dbSchema instead of connection
export async function generateTsFile(client: DbClient, sqlFile: string, target: 'node' | 'deno', isCrudFile: boolean) {

    const sqlContent = fs.readFileSync(sqlFile, 'utf8');

    const fileName = parse(sqlFile).name;
    const dirPath = parse(sqlFile).dir;
    const queryName = convertToCamelCaseName(fileName);

    const tsContent = await generateTsFileFromContent(client, sqlFile, queryName, sqlContent, target, isCrudFile);

    const tsFilePath = path.resolve(dirPath, fileName) + ".ts";

    writeFile(tsFilePath, tsContent);
}

export async function generateTsFileFromContent(client: DbClient, filePath: string, queryName: string, sqlContent: string, target: 'node' | 'deno', crud: boolean = false) {
    const queryInfo = await parseSql(client, sqlContent);

    if (isLeft(queryInfo)) {
        console.error('ERROR: ', queryInfo.left.description);
        console.error('at ', filePath);
    }

    const tsDescriptor = isLeft(queryInfo) ? none : some(generateTsDescriptor(queryInfo.right));
    const tsContent = generateTsContent(tsDescriptor, queryName, target, crud);
    return tsContent;
}

export type ParamInfo = {
    name: string;
    isList: boolean;
}

export type TsDescriptor = {
    sql: string;
    queryType: 'Select' | 'Insert' | 'Update' | 'Delete';
    multipleRowsResult: boolean;
    columns: TsFieldDescriptor[];
    parameterNames: ParamInfo[];
    parameters: TsFieldDescriptor[];
    data?: TsFieldDescriptor[];
    orderByColumns?: string[];
    nestedDescriptor?: NestedTsDescriptor;
}

function commaSeparator(length: number, index: number) {
    return length > 1 && index != length - 1 ? ',' : '';
}