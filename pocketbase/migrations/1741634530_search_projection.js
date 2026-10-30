/// <reference path="../pb_data/types.d.ts" />
// Additive private storage; PocketBase runs migrations atomically.
migrate(
  function (app) {
    // Validate the observed native affinity/identity contract before any DDL/write.
    var source = new DynamicModel({
      valid_columns: 0,
      shadow_rowid: 0,
      unique_count: 0,
      valid_unique: 0,
      distinct_keys: 0,
      source_sql: '',
    })
    app
      .db()
      .newQuery(
        "SELECT (SELECT COUNT(*) FROM pragma_table_info('price_samples_index') WHERE (name='id' AND upper(trim(type))='TEXT') OR (name='valor_unitario' AND upper(trim(type))='NUMERIC') OR (name='source' AND upper(trim(type))='TEXT') OR (name='uf' AND upper(trim(type))='TEXT') OR (name='data_referencia' AND upper(trim(type))='TEXT') OR (name='server_trust_version' AND upper(trim(type))='TEXT') OR (name='search_contract' AND upper(trim(type))='TEXT') OR (name='qualidade_situacao' AND upper(trim(type))='TEXT') OR (name='search_eligible' AND upper(trim(type))='NUMERIC') OR (name='sample_key' AND upper(trim(type))='TEXT')) AS valid_columns, (SELECT COUNT(*) FROM pragma_table_info('price_samples_index') WHERE lower(name) IN ('rowid','_rowid_','oid')) AS shadow_rowid, (SELECT COUNT(*) FROM pragma_index_list('price_samples_index') WHERE \"unique\"=1) AS unique_count, (SELECT COUNT(*) FROM pragma_index_list('price_samples_index') il WHERE il.\"unique\"=1 AND il.partial=0 AND (SELECT COUNT(*) FROM pragma_index_xinfo(il.name) WHERE key=1)=1 AND (SELECT COUNT(*) FROM pragma_index_xinfo(il.name) WHERE key=1 AND coll='BINARY' AND name IN ('id','sample_key'))=1) AS valid_unique, (SELECT COUNT(DISTINCT ix.name) FROM pragma_index_list('price_samples_index') il JOIN pragma_index_xinfo(il.name) ix WHERE il.\"unique\"=1 AND ix.key=1 AND ix.name IN ('id','sample_key')) AS distinct_keys, COALESCE((SELECT sql FROM sqlite_master WHERE type='table' AND name='price_samples_index'),'') AS source_sql",
      )
      .one(source)
    if (
      Number(source.valid_columns) !== 10 ||
      Number(source.shadow_rowid) !== 0 ||
      Number(source.unique_count) !== 2 ||
      Number(source.valid_unique) !== 2 ||
      Number(source.distinct_keys) !== 2 ||
      !source.source_sql ||
      /\bCOLLATE\b/i.test(source.source_sql)
    )
      throw new Error('SEARCH_PROJECTION_SOURCE_SCHEMA_MISMATCH')

    var definitions = [
      'CREATE TABLE cotai_price_search_projection_v1 (source_rowid INTEGER PRIMARY KEY,id TEXT UNIQUE,valor_unitario NUMERIC,source TEXT,uf TEXT,data_referencia TEXT,server_trust_version TEXT,search_contract TEXT,qualidade_situacao TEXT,search_eligible NUMERIC,sample_key TEXT UNIQUE)',
      'CREATE TRIGGER cotai_search_projection_ai_v1 AFTER INSERT ON price_samples_index BEGIN INSERT OR REPLACE INTO cotai_price_search_projection_v1 VALUES(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key); END',
      'CREATE TRIGGER cotai_search_projection_ad_v1 AFTER DELETE ON price_samples_index BEGIN DELETE FROM cotai_price_search_projection_v1 WHERE source_rowid=old.rowid; END',
      'CREATE TRIGGER cotai_search_projection_au_v1 AFTER UPDATE ON price_samples_index WHEN new.rowid IS NOT old.rowid OR new.id IS NOT old.id OR new.valor_unitario IS NOT old.valor_unitario OR new.source IS NOT old.source OR new.uf IS NOT old.uf OR new.data_referencia IS NOT old.data_referencia OR new.server_trust_version IS NOT old.server_trust_version OR new.search_contract IS NOT old.search_contract OR new.qualidade_situacao IS NOT old.qualidade_situacao OR new.search_eligible IS NOT old.search_eligible OR new.sample_key IS NOT old.sample_key BEGIN DELETE FROM cotai_price_search_projection_v1 WHERE source_rowid=old.rowid; INSERT OR REPLACE INTO cotai_price_search_projection_v1 VALUES(new.rowid,new.id,new.valor_unitario,new.source,new.uf,new.data_referencia,new.server_trust_version,new.search_contract,new.qualidade_situacao,new.search_eligible,new.sample_key); END',
      'CREATE VIEW cotai_search_projection_ready_v1 AS SELECT 1 AS version',
    ]
    var names = [
      'cotai_price_search_projection_v1',
      'cotai_search_projection_ai_v1',
      'cotai_search_projection_ad_v1',
      'cotai_search_projection_au_v1',
      'cotai_search_projection_ready_v1',
    ]
    var ready = new DynamicModel({ n: 0 })
    app
      .db()
      .newQuery(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='cotai_search_projection_ready_v1'",
      )
      .one(ready)
    for (var i = 0; i < definitions.length; i++) {
      var current = new DynamicModel({ sql: '' })
      app
        .db()
        .newQuery(
          "SELECT COALESCE(MAX(sql),'') AS sql FROM sqlite_master WHERE name='" + names[i] + "'",
        )
        .one(current)
      if (
        current.sql &&
        String(current.sql).replace(/\s/g, '').toLowerCase() !==
          definitions[i].replace(/\s/g, '').toLowerCase()
      )
        throw new Error('SEARCH_PROJECTION_DEFINITION_MISMATCH')
      if (!current.sql && i < 4) app.db().newQuery(definitions[i]).execute()
    }
    if (Number(ready.n) === 0)
      app
        .db()
        .newQuery(
          'INSERT INTO cotai_price_search_projection_v1 SELECT rowid,id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao,search_eligible,sample_key FROM price_samples_index',
        )
        .execute()
    var integrity = new DynamicModel({ n: 0 })
    app
      .db()
      .newQuery(
        'SELECT (SELECT COUNT(*) FROM (SELECT rowid,id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao,search_eligible,sample_key FROM price_samples_index EXCEPT SELECT * FROM cotai_price_search_projection_v1)) + (SELECT COUNT(*) FROM (SELECT * FROM cotai_price_search_projection_v1 EXCEPT SELECT rowid,id,valor_unitario,source,uf,data_referencia,server_trust_version,search_contract,qualidade_situacao,search_eligible,sample_key FROM price_samples_index)) AS n',
      )
      .one(integrity)
    if (Number(integrity.n) !== 0) throw new Error('SEARCH_PROJECTION_INCOMPLETE')
    if (Number(ready.n) === 0) app.db().newQuery(definitions[4]).execute()
  },
  function (_app) {
    // Retain additive storage while deployed hooks may reference it.
  },
)
