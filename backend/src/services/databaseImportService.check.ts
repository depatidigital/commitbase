import assert from 'node:assert/strict';
import { ImportError, SqlSplitter, plan, planMeta, prepare, sniffEngine, type SqlEvent } from './databaseImportService';

const split = (engine: 'POSTGRESQL' | 'MYSQL', text: string): SqlEvent[] => {
  const splitter = new SqlSplitter(engine);
  return [...text.split('\n').flatMap((line) => splitter.pushLine(line)), ...splitter.end()];
};
const sqls = (events: SqlEvent[]) => events.map((e) => ('sql' in e ? e.sql : 'command' in e ? e.command : e.type === 'data' ? e.text : e.type));

// pg_dump: comments dropped, \restrict passed through as meta, COPY data streamed until \.
const pgDump = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '\\restrict abc123',
  "SET client_encoding = 'UTF8';",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  'CREATE FUNCTION f() RETURNS text AS $body$',
  "  SELECT 'a;b'; -- not the end",
  '$body$ LANGUAGE sql;',
  'COPY public.t (id, note) FROM stdin;',
  '1\thello; world',
  '2\t\\N',
  '\\.',
  "INSERT INTO t VALUES (3, 'it''s; fine'), (4, E'back\\'slash;');",
  "INSERT INTO t VALUES (5, 'multi",
  "line; text');",
  '\\unrestrict abc123',
].join('\n');
const pg = split('POSTGRESQL', pgDump);
assert.deepEqual(sqls(pg), [
  '\\restrict abc123',
  "SET client_encoding = 'UTF8'",
  "SELECT pg_catalog.set_config('search_path', '', false)",
  "CREATE FUNCTION f() RETURNS text AS $body$\n  SELECT 'a;b'; -- not the end\n$body$ LANGUAGE sql",
  'COPY public.t (id, note) FROM stdin',
  '1\thello; world\n2\t\\N\n',
  'copyEnd',
  "INSERT INTO t VALUES (3, 'it''s; fine'), (4, E'back\\'slash;')",
  "INSERT INTO t VALUES (5, 'multi\nline; text')",
  '\\unrestrict abc123',
]);
// statements know the line they start on, for error messages
assert.equal((pg.find((e) => e.type === 'copy') as { line: number }).line, 10);

// pg: several statements on a line, nested block comments, $$ bodies, quoted names with ;
assert.deepEqual(sqls(split('POSTGRESQL', 'SET a = 1; SET b = 2;\n/* x /* y; */ z; */ SELECT 1;\nDO $$ BEGIN PERFORM 1; END $$;\nSELECT "a;b" FROM t;')), [
  'SET a = 1',
  'SET b = 2',
  '/* x /* y; */ z; */ SELECT 1',
  'DO $$ BEGIN PERFORM 1; END $$',
  'SELECT "a;b" FROM t',
]);
// old dumps: standard_conforming_strings off makes every '…' take backslash escapes
assert.deepEqual(sqls(split('POSTGRESQL', "SET standard_conforming_strings = off;\nINSERT INTO t VALUES ('a\\';b');")), [
  'SET standard_conforming_strings = off',
  "INSERT INTO t VALUES ('a\\';b')",
]);
// CRLF files: \r stays out of statements' ends, \. still ends COPY
assert.deepEqual(sqls(split('POSTGRESQL', 'SELECT 1;\r\nCOPY t FROM stdin;\r\n1\r\n\\.\r\nSELECT 2;\r')), [
  'SELECT 1',
  'COPY t FROM stdin',
  '1\r\n',
  'copyEnd',
  'SELECT 2',
]);

// mysqldump: conditional comments, backslash escapes, backticks, DELIMITER for triggers, # comments
const myDump = [
  '-- MySQL dump 10.13',
  '/*!40101 SET NAMES utf8mb4 */;',
  '# a hash comment',
  "INSERT INTO `t` VALUES (1,'it\\'s; ok'),(2,\"dq;\\\"x\");",
  'DELIMITER ;;',
  '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN',
  '  SET NEW.a = 1;',
  'END */;;',
  'DELIMITER ;',
  'SELECT `a;b` FROM t;',
  '--not-a-comment-in-mysql;',
].join('\n');
assert.deepEqual(sqls(split('MYSQL', myDump)), [
  '/*!40101 SET NAMES utf8mb4 */',
  "INSERT INTO `t` VALUES (1,'it\\'s; ok'),(2,\"dq;\\\"x\")",
  '/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`localhost`*/ /*!50003 TRIGGER tr BEFORE INSERT ON t FOR EACH ROW BEGIN\n  SET NEW.a = 1;\nEND */',
  'SELECT `a;b` FROM t',
  '--not-a-comment-in-mysql',
]);

// a last statement without ; still runs; an unclosed string or COPY is an error, not a silent stop
assert.deepEqual(sqls(split('POSTGRESQL', 'SELECT 1')), ['SELECT 1']);
assert.throws(() => split('POSTGRESQL', "INSERT INTO t VALUES ('oops);"), ImportError);
assert.throws(() => split('POSTGRESQL', 'COPY t FROM stdin;\n1'), ImportError);

// plan: tenant-impossible noise is skipped, other databases are refused
assert.equal(plan('POSTGRESQL', 'ALTER TABLE public.t OWNER TO postgres', 'acme_crm'), 'skip');
assert.equal(plan('POSTGRESQL', 'GRANT ALL ON TABLE public.t TO app', 'acme_crm'), 'skip');
assert.equal(plan('POSTGRESQL', "COMMENT ON EXTENSION plpgsql IS 'x'", 'acme_crm'), 'skip');
assert.equal(plan('POSTGRESQL', 'SET transaction_timeout = 0', 'acme_crm'), 'skip');
assert.equal(plan('POSTGRESQL', 'CREATE TABLE t (id int)', 'acme_crm'), 'run');
assert.throws(() => plan('POSTGRESQL', "CREATE DATABASE shop WITH ENCODING = 'UTF8'", 'acme_crm'), ImportError);
assert.throws(() => plan('POSTGRESQL', 'DROP DATABASE shop', 'acme_crm'), ImportError);
assert.equal(plan('POSTGRESQL', 'DROP SCHEMA public CASCADE', 'acme_crm'), 'run');
assert.equal(plan('MYSQL', 'USE `acme_crm`', 'acme_crm'), 'skip');
assert.equal(plan('MYSQL', 'CREATE DATABASE /*!32312 IF NOT EXISTS*/ `acme_crm` /*!40100 DEFAULT CHARACTER SET utf8mb4 */', 'acme_crm'), 'skip');
assert.throws(() => plan('MYSQL', 'USE `other_db`', 'acme_crm'), ImportError);
assert.throws(() => plan('MYSQL', 'CREATE DATABASE IF NOT EXISTS other_db', 'acme_crm'), ImportError);
assert.throws(() => plan('MYSQL', 'DROP DATABASE acme_crm', 'acme_crm'), ImportError);
assert.equal(plan('MYSQL', "SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'abc:1-5'", 'acme_crm'), 'skip');
assert.equal(plan('MYSQL', 'SET @@SESSION.SQL_LOG_BIN= 0', 'acme_crm'), 'skip');
assert.equal(plan('MYSQL', 'SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN', 'acme_crm'), 'run');

// psql commands: only pg_dump's \restrict pair gets through
assert.equal(planMeta('\\restrict abc', 'acme_crm'), 'skip');
assert.equal(planMeta('\\unrestrict abc', 'acme_crm'), 'skip');
assert.throws(() => planMeta('\\connect shop', 'acme_crm'), ImportError);
assert.throws(() => planMeta('\\! rm -rf /', 'acme_crm'), ImportError);
assert.throws(() => planMeta("\\copy t from '/etc/passwd'", 'acme_crm'), ImportError);

// MySQL DEFINERs are dropped (the object becomes ours); data is left alone
assert.equal(
  prepare('MYSQL', '/*!50013 DEFINER=`root`@`localhost` SQL SECURITY DEFINER */ VIEW v AS SELECT 1'),
  '/*!50013  SQL SECURITY DEFINER */ VIEW v AS SELECT 1',
);
assert.equal(prepare('MYSQL', "INSERT INTO t VALUES ('DEFINER=`x`@`y`')"), "INSERT INTO t VALUES ('DEFINER=`x`@`y`')");
assert.equal(prepare('POSTGRESQL', 'CREATE VIEW v AS SELECT 1'), 'CREATE VIEW v AS SELECT 1');

// sniffing: which engine a dump was made for
assert.equal(sniffEngine('--\n-- PostgreSQL database dump\n--'), 'POSTGRESQL');
assert.equal(sniffEngine('-- MySQL dump 10.13  Distrib 8.0'), 'MYSQL');
assert.equal(sniffEngine('-- MariaDB dump 10.19'), 'MYSQL');
assert.equal(sniffEngine('/*!40101 SET NAMES utf8 */;'), 'MYSQL');
assert.equal(sniffEngine('CREATE TABLE t (id int);'), null);

console.log('databaseImportService: splitter + plan + planMeta + prepare + sniff OK');
