import { splitName } from "./mysql-query-analyzer/select-columns";
import { ColumnInfo, DynamicSqlInfo, DynamicSqlInfo2, DynamicSqlInfoResult, DynamicSqlInfoResult2, FragmentInfo, FragmentInfoResult, FromFragementResult, FromFragment, TableField, WhereFragment, WhereFragmentResult, WithFragment } from "./mysql-query-analyzer/types";

export function describeDynamicQuery(dynamicQueryInfo: DynamicSqlInfo, namedParameters: string[], orderBy: string[]): DynamicSqlInfoResult {
    const { with: withFragments, select, from, where } = dynamicQueryInfo;

    const selectFragments = select.map((fragment, index) => {
        const fragmentResult: FragmentInfoResult = {
            fragment: fragment.fragment,
            fragmentWitoutAlias: fragment.fragementWithoutAlias,
            dependOnFields: [index], //remove duplicated
            dependOnParams: [],
            parameters: []
        }
        return fragmentResult;
    });
    const withFragements = withFragments?.map(fragment => transformFrom(fragment, withFragments, select, from, where, namedParameters, orderBy));
    const fromFragements = from.map(fragment => transformFrom(fragment, undefined, select, from, where, namedParameters, orderBy));

    const whereFragements = where.map(fragment => {

        const params = fragment.dependOnParams.map(paramIndex => namedParameters[paramIndex]);
        const fragmentResult: FragmentInfoResult = {
            fragment: fragment.fragment,
            dependOnFields: [],
            dependOnParams: params,
            parameters: params
        }
        return fragmentResult
    })

    const result: DynamicSqlInfoResult = {
        select: selectFragments,
        from: fromFragements,
        where: whereFragements
    };
    if (withFragements != null && withFragements.length > 0) {
        result.with = withFragements;
    }
    return result;
}

function transformFrom(fragment: FragmentInfo, withFragments: FragmentInfo[] | undefined, select: FragmentInfo[], from: FragmentInfo[], where: FragmentInfo[], namedParameters: string[], orderByColumns: string[]) {
    if (fragment.relation) {
        addAllChildFields(fragment, from, withFragments);
    }

    const filteredWhere = where.filter(whereFragment => includeAny(whereFragment.fields, fragment.fields));
    const hasUnconditional = filteredWhere
        .some(fragment => fragment.dependOnParams.length == 0);

    if (hasUnconditional) {
        return {
            fragment: fragment.fragment,
            dependOnFields: [],
            dependOnParams: [],
            parameters: fragment.parameters.map(paramIndex => namedParameters[paramIndex])
        }
    }

    const fieldIndex = select.flatMap((selectField, index) => {
        const found = selectField.dependOn.find(dependsOn => fragment.dependOn.includes(dependsOn));
        if (found) {
            return index;
        }
        return [];
    });

    const orderBy = orderByColumns.flatMap(orderBy => {
        const orderByField = splitName(orderBy);
        const found = fragment.fields.find(field => field.name == orderByField.name && (field.table == orderByField.prefix || orderByField.prefix == ''));
        if (found) {
            return orderBy;
        }
        return [];
    })

    const params = filteredWhere.flatMap(fragment => fragment.dependOnParams).map(paramIndex => namedParameters[paramIndex]);
    const fragmentResult: FragmentInfoResult = {
        fragment: fragment.fragment,
        dependOnFields: fieldIndex,
        dependOnParams: [...new Set(params)],
        parameters: fragment.parameters.map(paramIndex => namedParameters[paramIndex])
    }
    if (orderBy.length > 0) {
        fragmentResult.dependOnOrderBy = orderBy;
    }
    return fragmentResult;
}

function includeAny(fields: TableField[], fields2: TableField[]) {
    return fields.some(f => fields2.find(f2 => f2.field == f.field && f2.table == f.table));
}

function addAllChildFields(currentRelation: FragmentInfo, select: FragmentInfo[], withFragments: FragmentInfo[] | undefined) {
    currentRelation.dependOn.push(currentRelation.relation + '');
    select.forEach(fragment => {
        if (fragment.parentRelation == currentRelation.relation) {
            currentRelation.fields.push(...fragment.fields);
            currentRelation.dependOn.push(fragment.relation + '')
        }
        withFragments?.forEach(withFragment => {
            if (withFragment.parentRelation == fragment.relation) {
                withFragment.fields.push(...fragment.fields);
                withFragment.dependOn.push(fragment.relation + '');
            }
        })
    })

}

export function describeDynamicQuery2(columns: ColumnInfo[], dynamicQueryInfo: DynamicSqlInfo2, namedParameters: string[]): DynamicSqlInfoResult2 {
    const { with: withFragments, select, from, where } = dynamicQueryInfo;

    const fromResult = transformFromFragments(columns, from, where, namedParameters);

    const result: DynamicSqlInfoResult2 = {
        with: transformWithFragmnts(withFragments, fromResult, namedParameters),
        select: select,
        from: fromResult,
        where: transformWhereFragments(where, namedParameters)
    }
    return result;
}

function transformWithFragmnts(withFragments: WithFragment[], fromFragments: FromFragementResult[], namedParameters: string[]): FromFragementResult[] {
    return withFragments.map(withFragment => {
        const fromDependOn = fromFragments.filter(from => from.relationName == withFragment.relationName);
        const dependOnFields = fromDependOn.flatMap(from => from.dependOnFields);
        const dependOnParams = fromDependOn.flatMap(from => from.dependOnParams);
        const fromFragmentResult: FromFragementResult = {
            fragment: withFragment.fragment,
            relationName: withFragment.relationName,
            dependOnFields,
            dependOnParams,
            parameters: withFragment.parameters.map(paramIndex => namedParameters[paramIndex])
        }
        return fromFragmentResult;
    })
}

function transformFromFragments(columns: ColumnInfo[], fromFragments: FromFragment[], whereFragements: WhereFragment[], namedParameters: string[]): FromFragementResult[] {
    return fromFragments.map(from => {
        const dependOnParams = getDepenedOnParams(from, whereFragements).map(paramIndex => namedParameters[paramIndex]);
        const fromFragmentResult: FromFragementResult = {
            fragment: from.fragment,
            relationName: from.relationName,
            dependOnFields: getDependOnFields(columns, from),
            dependOnParams: [...new Set(dependOnParams)],
            parameters: from.parameters.map(paramIndex => namedParameters[paramIndex])
        }
        return fromFragmentResult;
    })
}

function transformWhereFragments(whereFragements: WhereFragment[], namedParameters: string[]): WhereFragmentResult[] {
    return whereFragements.map(where => {
        const parameters = where.fields.flatMap(field => field.parameters.map(param => namedParameters[param]));
        const whereFragmentResult: WhereFragmentResult = {
            fragment: where.fragment,
            dependOnParams: [...new Set(parameters)],
            parameters
        }
        return whereFragmentResult;
    })
}

function getDependOnFields(columns: ColumnInfo[], relationInfo: { relationName: string, relationAlias: string, parentRelation: string }): number[] {
    const dependOnFields = columns.flatMap((col, index) => {
        if ((col.table == relationInfo.relationName || col.table == relationInfo.relationAlias) && relationInfo.parentRelation != '') {
            return index;
        }
        return []
    });

    return dependOnFields;
}

function getDepenedOnParams(fromFragement: FromFragment, whereFragments: WhereFragment[]): number[] {
    const params = whereFragments.flatMap(whereFragement => {
        return whereFragement.fields.flatMap(field => {
            if (fromFragement.relationAlias == field.dependOnRelation) {
                return field.parameters
            }
            else {
                return []
            }
        })
    })

    return params;
}