
import assert from "assert";
import { parseAndInfer } from "../../src/mysql-query-analyzer/parse";
import { dbSchema } from "./create-schema";
import { TypeInferenceResult } from "../../src/mysql-query-analyzer/types";

describe('type-inference test', () => {

    it(`SELECT id FROM mytable1`, () => {
        const sql = `INSERT INTO mytable1 (value) VALUES (?)`;
        const actual = parseAndInfer(sql, dbSchema);

        const expected : TypeInferenceResult = {
            columns: [],
            parameters: ['int']   
        }

        assert.deepEqual(actual, expected);
    })

    it(`INSERT INTO mydb.mytable1 (value) VALUES (?)`, () => {
        const sql = `INSERT INTO mydb.mytable1 (value) VALUES (?)`;
        const actual = parseAndInfer(sql, dbSchema);

        const expected : TypeInferenceResult = {
            columns: [],
            parameters: ['int']   
        }

        assert.deepEqual(actual, expected);
    })

    it(`INSERT INTO alltypes (double_column, int_column, varchar_column) VALUES (?, ?, ?)`, () => {
        const sql = `INSERT INTO all_types (double_column, int_column, varchar_column) VALUES (?, ?, ?)`;
        const actual = parseAndInfer(sql, dbSchema);

        const expected : TypeInferenceResult = {
            columns: [],
            parameters: ['double', 'int', 'varchar']   
        }

        assert.deepEqual(actual, expected);
    })
    

});