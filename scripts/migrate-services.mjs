#!/usr/bin/env node
/**
 * Plan, probe and apply the migration of a config's layer URLs from the old
 * EduGIS services (tiles.edugis.nl, mapserver.edugis.nl, kaart.edugis.nl) to
 * the new stack: pg_tileserv + GeoServer behind the edugis-cache edge.
 *
 * The config is the specification. Every service a config needs is already
 * named in it, so migration is an inventory, not an exploration — and the
 * failures are found by probing URLs, never by opening a viewer.
 *
 * Four modes:
 *
 *   --plan             what each URL becomes, and what has no rule yet
 *   --views            the SQL the planned pg_tileserv URLs require
 *   --probe --base URL does each planned URL actually serve something
 *   --write            apply the plan to the config file
 *
 * Usage:
 *   node scripts/migrate-services.mjs nl.json --plan
 *   node scripts/migrate-services.mjs nl.json --views > ../edugis-data/views/nl.sql
 *   node scripts/migrate-services.mjs nl.json --probe --base https://kaart.blankert.com
 *   node scripts/migrate-services.mjs nl.json --write
 *
 * URLs are rewritten RELATIVE (/tiles/..., /legacy/mapserv), so the origin
 * serving the viewer serves the tiles. That removes the hostname from the
 * config: no hosts-file override to test locally, no TLS mismatch, and no
 * alias (t1/t2/t3.edugis.nl) quietly still hitting the old stack. Third-party
 * services (PDOK, OSM, ...) keep their absolute URLs — not ours to move.
 *
 * ---------------------------------------------------------------------------
 * Why pg_tileserv, and why a view per geometry column
 *
 * The old URLs are pgbrowser's (geodan/pgbrowser, /data/<s>.<t>/mvt/...):
 * the client names the attributes it wants, so a table with fifty columns
 * still yields a small tile, and pgbrowser's cache key includes that column
 * list. pg_tileserv keeps the capability as ?properties=a,b, and because the
 * edge caches on the full URL including query string, column selection still
 * caches per variant — with ONE cache instead of pgbrowser's own file cache
 * plus the edge's, which would otherwise both have to be purged.
 *
 * What pg_tileserv cannot do is serve two geometry columns from one table.
 * Its catalog query returns a row per geometry column but ids each layer
 * `schema.table` with no column component (layer_table.go), so the rows
 * collide and the last one loaded wins — undocumented and arbitrary. Every
 * (table, geometry column) pair therefore gets its own view, named
 * `<table>__<geomcolumn>`, so that:
 *
 *   - the view name says which table and which column it came from;
 *   - re-creating a table means re-running the helper for that table, and
 *     dropping it means dropping `<table>__%` — no separate registry to
 *     keep in step with the tables.
 *
 * The view must expose exactly one geometry column, so it cannot be written
 * as SELECT * (that would carry the other geometry columns and collide
 * again). The column list depends on the table as it exists, which no
 * offline script can know, so --views emits an introspecting helper rather
 * than static DDL.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const TIMEOUT_MS = 15000;

/**
 * Where to probe. Sampled over the middle of the Netherlands at a zoom where
 * the layers in nl.json have data: a layer with a smaller extent answers
 * "empty" from anywhere else and looks broken when it is not.
 */
const SAMPLE = { lon: 5.375, lat: 52.168, zoom: 10 };

/** Schema renames from the eduqgis import (import_eduqgis_tables.sh). */
const SCHEMA_RENAMES = { public: 'eduqgis_public' };

/** pgbrowser's default when a URL names no geometry column (mvt.js). */
const DEFAULT_GEOM = 'geom';

const VIEW_SEP = '__';

/**
 * Origin serving the tiles and the legacy MapServer bridge, i.e. the
 * edugis-cache edge. Absolute rather than relative, because the viewer and
 * the tile cache are different hosts (kaart.edugis.nl vs tiles.edugis.nl)
 * and always have been -- a root-relative /tiles/... would resolve against
 * whatever host serves the config. A config already names PDOK, OSM and
 * ArcGIS absolutely; the cache is one more origin.
 *
 * Renaming it later (tiles.edugis.nl, cache.edugis.nl) is a re-run of this
 * tool with a different --tile-origin.
 */
const DEFAULT_TILE_ORIGIN = 'https://tiles.blankert.com';

/**
 * Catalogs to drop rather than repoint.
 *
 * Their layers were never migrated, and rebuilding them from a 2010
 * mapfile is the wrong move: two still work upstream but are 2005/2010-era
 * extracts whose MapServer classes the converter could not translate, and
 * three were already broken before the migration (blank or no response
 * when probed against the live old stack). All five are better renewed
 * from current source data. See edugis-geoserver/scripts/layers_todo.md.
 *
 * Left in the config they would render nothing, which is worse than an
 * absent category: a student cannot tell a broken layer from an empty one.
 */
const DROP_CATALOGS = new Set([
    'cbs_bodemgebruik.xml',   // no response upstream
    'ehs.xml',                // blank upstream
    'kadaster.xml',           // blank upstream
    'voorzieningen_onderwijs.xml',  // works upstream, needs renewing
    'voorzieningen_ov.xml',         // works upstream, needs renewing
    // Pre-2020 election results: superseded, and 93 layers of a
    // twelve-party by three-aggregation-level grid nobody asks for now.
    'verkiezingen.xml',
    'verkiezingen_2010.xml',
    'verkiezingen_2012.xml',
]);

/**
 * The old catalogs are frozen MapServer 5.6.7 capabilities documents, one
 * per theme, each listing ~12 layers. GeoServer serves everything from one
 * endpoint, so pointing a category at it directly would show all ~600
 * layers. The narrowing moves into allowedLayers, which webmapx already
 * applies -- and since each mapfile layer is now published under its own
 * name (edugis-geoserver 16a0b2f), the old names carry over unchanged.
 *
 * Kept as a live GetCapabilities rather than expanded into explicit layer
 * entries: the fetch is lazy, so a category nobody opens costs nothing,
 * and inlining ~500 layers would make every visitor download a tree they
 * will not expand.
 */
const OLD_CATALOG = /^https?:\/\/kaart\.edugis\.nl\/data\/nederland\/([^/]+\.xml)$/i;

function tileXY({ lon, lat, zoom }) {
    const n = 2 ** zoom;
    const x = Math.floor((lon + 180) / 360 * n);
    const rad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n);
    return { z: zoom, x, y };
}

/** "id",name  →  ['id','name'];  diepte%20(m) is already decoded by URLSearchParams. */
function parseColumns(raw) {
    if (!raw) return [];
    return raw.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

const RULES = [
    {
        name: 'pg_tileserv',
        // pgbrowser: /data/<schema>.<table>/mvt/{z}/{x}/{y}
        // and the older /v1/mvt/<schema>.<table>/{z}/{x}/{y}
        match: /^https?:\/\/[^/]*edugis\.nl\/(?:data\/([a-z0-9_]+)\.([a-z0-9_]+)\/mvt|v1\/mvt\/([a-z0-9_]+)\.([a-z0-9_]+))\//i,
        plan(url, m) {
            const schema = SCHEMA_RENAMES[m[1] ?? m[3]] ?? (m[1] ?? m[3]);
            const table = m[2] ?? m[4];
            const q = new URL(url, 'https://x.invalid').searchParams;
            // Both spellings occur in the wild; pgbrowser accepts either.
            const geom = q.get('geom_column') ?? q.get('geomcolumn') ?? DEFAULT_GEOM;
            const columns = parseColumns(q.get('columns'));
            const view = `${table}${VIEW_SEP}${geom}`;
            // No ?properties=. The view carries the attribute list, so the url
            // is just the layer: configs stop repeating 35-column lists, and
            // more importantly the cache key stops varying by column set --
            // one url per tile instead of one per combination, which is what
            // makes a per-layer purge enumerable at all.
            //
            // The views are wide (every non-geometry column). For the polygon
            // layers that is deliberate: one cache serves every thematic map
            // of the same table, switching theme costs no request, and two
            // attributes in one tile is what lets a client compare them.
            // A huge table drawn one attribute at a time (cbs_vk100_2020)
            // wants narrow named views instead; those are not generated yet.
            const qs = '';
            const notes = [];
            if (columns.length) {
                notes.push(`${columns.length} columns now come from the view`);
            }
            if (q.get('include_nulls') === '0' || q.get('include_nulls') === 'false') {
                // pgbrowser drops rows whose selected attributes are all NULL.
                // pg_tileserv has no equivalent; the view's WHERE clause is the
                // natural home for it, but only where a layer really needs it.
                notes.push('include_nulls=0 dropped — express in the view or as a CQL filter if it matters');
            }
            return {
                url: `${TILE_ORIGIN}/tiles/${schema}.${view}/{z}/{x}/{y}.pbf${qs}`,
                view: { schema, table, geom, view },
                notes,
            };
        },
    },
    {
        name: 'legacy-mapserver',
        // The edge proxies these to the old MapServer origin, so they keep
        // working unchanged until GeoServer equivalents land.
        match: /^https?:\/\/mapserver\.edugis\.nl\/cgi-bin\/mapserv/i,
        plan(url) {
            const qs = url.split('?')[1] ?? '';
            return { url: `${TILE_ORIGIN}/legacy/mapserv${qs ? '?' + qs : ''}`, notes: ['via edge bridge; migrate to GeoServer later'] };
        },
    },
    {
        name: 'hosted-data',
        // Static GeoJSON/XML on the old viewer host: files, not services.
        match: /^https?:\/\/kaart\.edugis\.nl\/data\/(.+)$/i,
        plan(url, m) {
            return { url: `data/${m[1]}`, notes: ['file must be copied into webmapx-configs/data/'] };
        },
    },
    { name: 'edugis-layer-json', match: /^https?:\/\/kaart\.edugis\.nl\/v2\/maps\/layers\/(.+)\.json$/i, blocked: 'EduGIS layer-definition indirection; should be inlined at conversion time' },
    { name: 'mapproxy', match: /^https?:\/\/[^/]*edugis\.nl\/mapproxy\//i, blocked: 'mapproxy is not part of the new stack — needs a GeoServer/GWC equivalent' },
    { name: 'wcsahn', match: /^https?:\/\/(?:tiles|t[123])\.edugis\.nl\/wcsahn\//i, blocked: 'AHN elevation tiles; TILEINDEX mosaic still deferred (see layers_todo.md)' },
    { name: 'qgis-server', match: /^https?:\/\/map\.edugis\.nl\/cgi-bin\/qgis_mapserv/i, blocked: 'QGIS Server; no equivalent in the new stack yet' },
    { name: 'saturnus', match: /^https?:\/\/saturnus\.geodan\.nl\//i, blocked: 'Geodan-hosted service, outside EduGIS — adopt or replace' },
];

const looksLikeUrl = (s) => /^https?:\/\//i.test(s);

/**
 * Urls this tool has already rewritten. Without these, --probe after
 * --write reports 0/0: nothing matches a rewrite rule any more, so there
 * would be no way to check the result of a migration -- only to plan one.
 */
const isMigrated = (u) => MIGRATED.some((m) => m.match.test(u));

const MIGRATED = [
    { rule: 'pg_tileserv', match: /^(?:https?:\/\/[^/]+)?\/tiles\/[a-z0-9_]+\.[a-z0-9_]+\// },
    { rule: 'legacy-mapserver', match: /^(?:https?:\/\/[^/]+)?\/legacy\/mapserv/ },
    { rule: 'hosted-data', match: /^data\// },
];

/** Every URL-bearing string in the config, with a setter for --write. */
function urlSites(config) {
    const sites = [];
    const visit = (node) => {
        if (Array.isArray(node)) {
            node.forEach((v, i) => {
                if (typeof v === 'string' && (looksLikeUrl(v) || isMigrated(v))) sites.push({ get: () => node[i], set: (nv) => { node[i] = nv; } });
                else visit(v);
            });
            return;
        }
        if (!node || typeof node !== 'object') return;
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string' && ['url', 'data', 'styleUrl', 'tiles'].includes(k) && (looksLikeUrl(v) || isMigrated(v))) {
                sites.push({ get: () => node[k], set: (nv) => { node[k] = nv; } });
            } else visit(v);
        }
    };
    visit(config);
    return sites;
}

/**
 * `source-layer` must name the MVT layer inside the tile, which for
 * pg_tileserv is the full published id -- `edugis.buurt_2005__the_geom`, not
 * the `edugis.buurt_2005` the old postgis-mvt-server used. Rewriting a tile
 * URL therefore invalidates the `source-layer` the config was carrying, and a
 * layer with the wrong one answers HTTP 200 and draws nothing, so --probe
 * cannot see the breakage. Aligning them is a separate pass because it needs
 * the enclosing style object, which urlSites() has deliberately forgotten.
 */
function sourceLayerFixes(config) {
    const fixes = [];
    const idOf = (url) => (typeof url === 'string' ? url.match(/\/tiles\/([^/]+)\/\{z\}/)?.[1] : undefined);
    const visit = (node) => {
        if (Array.isArray(node)) { node.forEach(visit); return; }
        if (!node || typeof node !== 'object') return;
        if (node.sources && typeof node.sources === 'object' && Array.isArray(node.layers)) {
            const published = new Map();
            for (const [name, source] of Object.entries(node.sources)) {
                if (!source || source.type !== 'vector') continue;
                const urls = source.tiles ?? (typeof source.url === 'string' ? [source.url] : []);
                for (const u of urls) {
                    const id = idOf(u);
                    if (id) published.set(name, id);
                }
            }
            for (const layer of node.layers) {
                if (!layer || typeof layer !== 'object') continue;
                const want = published.get(layer.source);
                if (!want || layer['source-layer'] === want) continue;
                fixes.push({ layer, from: layer['source-layer'], to: want, in: node.id ?? node.title });
            }
        }
        for (const v of Object.values(node)) visit(v);
    };
    visit(config);
    return fixes;
}

function planUrl(url) {
    for (const m of MIGRATED) {
        if (m.match.test(url)) return { rule: m.rule, url, already: true };
    }
    for (const rule of RULES) {
        const m = url.match(rule.match);
        if (!m) continue;
        if (rule.blocked) return { rule: rule.name, blocked: rule.blocked };
        return { rule: rule.name, ...rule.plan(url, m) };
    }
    return { rule: null };
}

/** pg_tileserv lists its published layers at /index.json. */
async function loadCatalog(base) {
    try {
        const res = await fetch(new URL('/tiles/index.json', base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!res.ok) return { error: `HTTP ${res.status}` };
        return { sources: Object.keys(await res.json()) };
    } catch (e) {
        return { error: String(e.message ?? e) };
    }
}

async function probe(url, base) {
    const started = Date.now();
    try {
        const res = await fetch(new URL(url, base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
        const ms = Date.now() - started;
        if (res.status === 204) return { state: 'empty', http: 204, ms };
        if (!res.ok) return { state: 'fail', http: res.status, ms };
        const bytes = (await res.arrayBuffer()).byteLength;
        // A tile with no features is a real answer from a working service and
        // a different problem from a broken URL, so it is named separately.
        if (bytes === 0) return { state: 'empty', http: res.status, ms };
        return { state: 'ok', http: res.status, ms, bytes };
    } catch (e) {
        return { state: 'unreachable', ms: Date.now() - started, reason: String(e.message ?? e) };
    }
}

/**
 * The helper, plus one call per (table, geometry column) the config uses.
 *
 * A view is emitted for every referenced pair, including tables that have
 * only one geometry column today. Uniformity is the point: the tile URL is
 * then derivable from table+column without knowing the table's shape, and a
 * table that gains a second geometry column later does not silently start
 * serving the wrong one.
 */
function viewSql(views) {
    const calls = [...views.values()]
        .sort((a, b) => `${a.schema}.${a.view}`.localeCompare(`${b.schema}.${b.view}`))
        .map((v) => `SELECT webmapx_geom_view('${v.schema}', '${v.table}', '${v.geom}');`);

    return `-- Generated by webmapx-configs/scripts/migrate-services.mjs --views
--
-- One view per (table, geometry column) referenced by the config, named
-- <table>__<geomcolumn>. pg_tileserv ids a layer by schema.table with no
-- geometry-column component, so a table with two geometry columns publishes
-- one arbitrary layer; a view per column is what makes each addressable.
--
-- The name is derived from the table, so re-importing a table means re-running
-- its calls below, and retiring one means:
--     SELECT webmapx_drop_geom_views('<schema>', '<table>');
-- No registry to keep in step with the tables.

CREATE OR REPLACE FUNCTION webmapx_geom_view(p_schema text, p_table text, p_geom text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    v_name text := p_table || '${VIEW_SEP}' || p_geom;
    v_cols text;
    v_srid integer;
BEGIN
    -- Every non-geometry column, plus the chosen geometry aliased to "geom".
    -- Selecting * would carry the table's OTHER geometry columns into the
    -- view, which is the collision this exists to avoid.
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
      INTO v_cols
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
     WHERE n.nspname = p_schema
       AND c.relname = p_table
       AND a.attnum > 0
       AND NOT a.attisdropped
       AND t.typname <> 'geometry';

    IF v_cols IS NULL THEN
        RAISE EXCEPTION 'no such table: %.%', p_schema, p_table;
    END IF;

    -- A config may name a geometry column the imported table does not have
    -- -- the source database has it but the import predates it, or the
    -- layer has been broken upstream for a while. Skip with a notice
    -- rather than aborting: one stale reference must not stop the other
    -- fifty-odd views from being created, and the run has to stay
    -- re-runnable after the data is fixed.
    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = p_schema AND c.relname = p_table
           AND a.attname = p_geom AND a.attnum > 0 AND NOT a.attisdropped
    ) THEN
        RAISE WARNING 'skipping %.%__%: no geometry column %', p_schema, p_table, p_geom, p_geom;
        RETURN;
    END IF;

    -- ST_Force2D because a source with a Z dimension does not fit a 2D
    -- geometry() type and pg_tileserv answers 500 ("Geometry has Z
    -- dimension but column does not") for every tile. Nothing is lost:
    -- MVT is 2D, so the tile pipeline would drop Z anyway. A layer that
    -- genuinely needs its third dimension is not served this way.
    --
    -- Older PostGIS tables carry their SRID in a CHECK constraint rather
    -- than the column's typmod. A view inherits neither, so geometry_columns
    -- reports srid 0 for it and pg_tileserv skips the layer entirely --
    -- silently, since an unpublished layer looks the same as one that was
    -- never created. Stamping the SRID into the view's column type is what
    -- makes those tables usable; for typmod-based tables it is a no-op.
    SELECT srid INTO v_srid FROM geometry_columns
     WHERE f_table_schema = p_schema AND f_table_name = p_table
       AND f_geometry_column = p_geom;

    -- CREATE OR REPLACE cannot change a column's type, and re-running this
    -- after the SRID fix does exactly that (geometry(Point,28992) ->
    -- geometry(Geometry,28992)). Drop first so the generator stays
    -- re-runnable; these views hold no data and nothing depends on them
    -- but the tile server.
    EXECUTE format('DROP VIEW IF EXISTS %I.%I', p_schema, v_name);

    IF v_srid IS NULL OR v_srid = 0 THEN
        RAISE WARNING '%.% has no SRID on %; view created but tile servers will skip it',
            p_schema, p_table, p_geom;
        EXECUTE format(
            'CREATE VIEW %I.%I AS SELECT %s, %I AS geom FROM %I.%I WHERE %I IS NOT NULL',
            p_schema, v_name, v_cols, p_geom, p_schema, p_table, p_geom);
    ELSE
        EXECUTE format(
            'CREATE VIEW %I.%I AS SELECT %s, ST_Force2D(ST_SetSRID(%I, %s))::geometry(Geometry,%s) AS geom FROM %I.%I WHERE %I IS NOT NULL',
            p_schema, v_name, v_cols, p_geom, v_srid, v_srid, p_schema, p_table, p_geom);
    END IF;

    EXECUTE format(
        'COMMENT ON VIEW %I.%I IS %L',
        p_schema, v_name,
        format('generated by webmapx_geom_view(%L, %L, %L); tile layer %s.%s',
               p_schema, p_table, p_geom, p_schema, v_name));
END;
$fn$;

CREATE OR REPLACE FUNCTION webmapx_drop_geom_views(p_schema text, p_table text)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT c.relname FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = p_schema
           AND c.relkind = 'v'
           AND c.relname LIKE p_table || '${VIEW_SEP}' || '%'
    LOOP
        EXECUTE format('DROP VIEW IF EXISTS %I.%I', p_schema, r.relname);
    END LOOP;
END;
$fn$;

-- ${calls.length} view(s) for this config:

${calls.join('\n')}
`;
}

/** Layer names in a WMS 1.1.1 capabilities document, minus the service entry. */
function capabilityLayerNames(xml) {
    return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)]
        .map((m) => m[1])
        .filter((n) => n !== 'OGC:WMS' && n !== 'default');
}

/**
 * Repoint every old per-theme catalog at GeoServer, and drop the ones whose
 * layers are to be renewed rather than repaired.
 *
 * Returns a summary; mutates the config in place.
 */
async function expandCapabilities(config, base) {
    const geoserverCaps = `${base}/geoserver/edugis/wms?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.1.1`;
    const summary = { repointed: [], dropped: [], failed: [], unavailable: [] };

    // What GeoServer actually publishes. A name the migration skipped would
    // otherwise sit in allowedLayers and render nothing -- and a layer that
    // draws nothing is worse than an absent one, because a student cannot
    // tell it from an empty map.
    let available = null;
    try {
        // Cache-Control bypasses the edge's year-long cache for capabilities
        // (nginx.conf honours it for GetCapabilities only). Without it this
        // reads a document from before the last migration run and drops every
        // layer published since as "not available".
        const res = await fetch(geoserverCaps, {
            headers: { 'Cache-Control': 'no-cache' },
            signal: AbortSignal.timeout(TIMEOUT_MS * 4),
        });
        if (res.ok) {
            const xml = await res.text();
            available = new Set(capabilityLayerNames(xml).flatMap((n) => [n, n.split(':').pop()]));
        }
    } catch { /* unreachable: fall through and keep every name */ }
    if (!available) {
        console.log('⚠ could not read GeoServer capabilities; allowedLayers left unverified');
    }

    // Collect nodes with their containing array, so a dropped catalog can be
    // removed rather than left pointing at nothing.
    const found = [];
    const visit = (node, parent, index) => {
        if (Array.isArray(node)) { node.forEach((v, i) => visit(v, node, i)); return; }
        if (!node || typeof node !== 'object') return;
        if (node.type === 'getcapabilities' && typeof node.url === 'string') {
            found.push({ node, parent, index });
        }
        for (const v of Object.values(node)) visit(v, null, null);
    };
    visit(config, null, null);

    const removals = [];
    for (const { node, parent, index } of found) {
        const m = node.url.match(OLD_CATALOG);
        if (!m) continue;                       // qgis/mapproxy/live mapserver: untouched
        const file = m[1];

        if (DROP_CATALOGS.has(file)) {
            summary.dropped.push({ file, label: node.label });
            if (parent) removals.push({ parent, index });
            continue;
        }

        let names;
        try {
            const res = await fetch(node.url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            names = capabilityLayerNames(await res.text());
        } catch (e) {
            summary.failed.push({ file, reason: String(e.message ?? e) });
            continue;
        }

        // The old filters applied to the old, narrow document. Fold them into
        // the allowedLayers list now that the document is the wide one --
        // deniedLayers against ~600 layers would mean something entirely
        // different from deniedLayers against twelve.
        if (Array.isArray(node.allowedLayers)) {
            names = names.filter((n) => node.allowedLayers.includes(n));
        } else if (Array.isArray(node.deniedLayers)) {
            names = names.filter((n) => !node.deniedLayers.includes(n));
        }

        if (available) {
            // migrate_mapfile.py normalises hyphens to underscores in layer
            // names, so a mapfile's "heerlen-ransdael" is published as
            // "heerlen_ransdael". Match that rather than reporting it missing.
            const resolved = (n) => (available.has(n) ? n
                : available.has(n.replace(/-/g, '_')) ? n.replace(/-/g, '_')
                : null);
            const missing = names.filter((n) => !resolved(n));
            if (missing.length) summary.unavailable.push({ file, label: node.label, missing });
            names = names.map(resolved).filter(Boolean);
        }

        node.url = geoserverCaps;
        node.allowedLayers = names;
        delete node.deniedLayers;
        // The edge caches whatever WMS url is requested, so the old separate
        // tile-cache endpoint has nothing left to do.
        delete node.tilecacheUrl;
        summary.repointed.push({ file, label: node.label, layers: names.length });
    }

    // Remove back-to-front so earlier indices stay valid.
    for (const { parent, index } of removals.sort((a, b) => b.index - a.index)) {
        parent.splice(index, 1);
    }
    return summary;
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const mode = args.includes('--capabilities') ? 'capabilities'
    : args.includes('--write') ? 'write'
    : args.includes('--views') ? 'views'
    : args.includes('--probe') ? 'probe' : 'plan';
const baseArg = args.indexOf('--base');
const base = baseArg >= 0 ? args[baseArg + 1] : null;
const originArg = args.indexOf('--tile-origin');
const TILE_ORIGIN = (originArg >= 0 ? args[originArg + 1] : DEFAULT_TILE_ORIGIN).replace(/\/$/, '');

if (!file) {
    console.error('usage: migrate-services.mjs <config.json> [--plan|--capabilities|--views|--probe --base URL|--write]');
    process.exit(2);
}
if (mode === 'probe' && !base) {
    console.error('--probe needs --base, e.g. --base https://kaart.blankert.com');
    process.exit(2);
}

const path = resolve(file);
const config = JSON.parse(readFileSync(path, 'utf8'));
const sites = urlSites(config);

if (mode === 'capabilities') {
    const origin = TILE_ORIGIN;
    const r = await expandCapabilities(config, origin);
    if (r.repointed.length) {
        console.log(`\n▸ repointed at ${origin}/geoserver/edugis/wms (${r.repointed.length})`);
        for (const e of r.repointed) console.log(`   ${e.file.padEnd(34)} ${String(e.layers).padStart(3)} layers   ${e.label ?? ''}`);
    }
    if (r.dropped.length) {
        console.log(`\n▸ dropped, to be renewed from source (${r.dropped.length})`);
        for (const e of r.dropped) console.log(`   ${e.file.padEnd(34)} ${e.label ?? ''}`);
    }
    if (r.unavailable.length) {
        const n = r.unavailable.reduce((a, e) => a + e.missing.length, 0);
        console.log(`\n▸ omitted, not published by GeoServer (${n})`);
        for (const e of r.unavailable) console.log(`   ${e.file.padEnd(34)} ${e.missing.join(', ')}`);
    }
    if (r.failed.length) {
        console.log(`\n▸ could not read (${r.failed.length})`);
        for (const e of r.failed) console.log(`   ${e.file.padEnd(34)} ${e.reason}`);
    }
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    console.log(`\nwrote ${file}`);
    process.exit(r.failed.length ? 1 : 0);
}


// One entry per distinct URL: a config repeats the same source across layers.
const byUrl = new Map();
for (const site of sites) {
    const url = site.get();
    if (!byUrl.has(url)) byUrl.set(url, { url, plan: planUrl(url), sites: [] });
    byUrl.get(url).sites.push(site);
}
const entries = [...byUrl.values()];
const planned = entries.filter((e) => e.plan.url);
const blocked = entries.filter((e) => e.plan.blocked);
const untouched = entries.filter((e) => !e.plan.rule);

// Distinct (table, geometry column) pairs across all planned URLs.
const views = new Map();
for (const e of planned) {
    if (!e.plan.view) continue;
    views.set(`${e.plan.view.schema}.${e.plan.view.view}`, e.plan.view);
}

if (mode === 'views') {
    process.stdout.write(viewSql(views));
    process.exit(0);
}

if (mode === 'probe') {
    const catalog = await loadCatalog(base);
    if (catalog.error) {
        console.log(`⚠ pg_tileserv index unreachable at ${base}/tiles/index.json: ${catalog.error}`);
        console.log('  Tile URLs are probed anyway; a missing view will show as an error.\n');
    } else {
        console.log(`pg_tileserv: ${catalog.sources.length} layers published\n`);
    }

    const { z, x, y } = tileXY(SAMPLE);
    const results = { ok: [], empty: [], fail: [], unreachable: [], unpublished: [] };

    for (const e of planned) {
        const v = e.plan.view;
        if (v && catalog.sources && !catalog.sources.includes(`${v.schema}.${v.view}`)) {
            results.unpublished.push({ ...e, why: `no layer ${v.schema}.${v.view} — run the --views SQL, or the table is missing` });
            continue;
        }
        const r = await probe(e.plan.url.replace('{z}', z).replace('{x}', x).replace('{y}', y), base);
        results[r.state].push({ ...e, probe: r });
    }

    const show = (label, list, icon) => {
        if (list.length === 0) return;
        console.log(`${icon} ${label} (${list.length})`);
        for (const e of list) {
            console.log(`   ${e.plan.url.slice(0, 78).padEnd(78)} ${e.probe ? `HTTP ${e.probe.http ?? '-'} ${e.probe.ms}ms` : e.why}`);
        }
        console.log();
    };
    show('serving', results.ok, '✅');
    show('empty at the sample tile', results.empty, '⬜');
    show('not published', results.unpublished, '❓');
    show('error', results.fail, '❌');
    show('unreachable', results.unreachable, '💥');
    const stale = sourceLayerFixes(config);
    if (stale.length) {
        console.log(`⚠ ${stale.length} layer(s) name a source-layer the tile does not contain — they return HTTP 200 and draw nothing.`);
        for (const f of stale.slice(0, 8)) console.log(`   ${String(f.from).padEnd(50)} → ${f.to}`);
        if (stale.length > 8) console.log(`   … and ${stale.length - 8} more`);
        console.log('  Run --write to align them.\n');
    }
    console.log(`${results.ok.length}/${planned.length} planned URLs serve data. ${blocked.length} still have no rule.`);
    process.exit(results.fail.length + results.unreachable.length > 0 ? 1 : 0);
}

if (mode === 'plan') {
    const byRule = new Map();
    for (const e of planned) {
        if (!byRule.has(e.plan.rule)) byRule.set(e.plan.rule, []);
        byRule.get(e.plan.rule).push(e);
    }
    for (const [rule, list] of byRule) {
        console.log(`\n▸ ${rule} (${list.length})`);
        for (const e of list) {
            console.log(`   ${e.url.slice(0, 96)}`);
            console.log(`   → ${e.plan.url}${e.plan.notes?.length ? '   [' + e.plan.notes.join('; ') + ']' : ''}`);
        }
    }
    if (views.size) console.log(`\n▸ ${views.size} view(s) required — see --views`);
    if (blocked.length) {
        console.log(`\n▸ no rule yet (${blocked.length}) — this is the work list`);
        const grouped = new Map();
        for (const e of blocked) {
            if (!grouped.has(e.plan.blocked)) grouped.set(e.plan.blocked, []);
            grouped.get(e.plan.blocked).push(e.url);
        }
        for (const [why, urls] of [...grouped].sort((a, b) => b[1].length - a[1].length)) {
            console.log(`\n   ${why}  (${urls.length})`);
            for (const u of urls.slice(0, 8)) console.log(`      ${u.slice(0, 100)}`);
            if (urls.length > 8) console.log(`      … and ${urls.length - 8} more`);
        }
    }
    console.log(`\n${planned.length} rewritable, ${blocked.length} blocked, ${untouched.length} third-party (left alone).`);
    process.exit(0);
}

// --write
//
// Run --capabilities FIRST. The hosted-data rule rewrites
// kaart.edugis.nl/data/nederland/*.xml to a relative data/... path, and the
// old per-theme catalogs live at exactly those urls -- so a --write first
// leaves them looking migrated while still pointing at frozen MapServer
// 5.6.7 documents, and --capabilities afterwards silently matches nothing.
const unconverted = entries.filter((e) => OLD_CATALOG.test(e.url));
if (unconverted.length) {
    console.error(`refusing: ${unconverted.length} old capabilities catalog(s) not yet repointed.`);
    console.error('Run --capabilities before --write, or those catalogs keep pointing at');
    console.error('frozen MapServer documents that this rewrite would merely make relative.');
    process.exit(2);
}

let changed = 0;
for (const e of planned) {
    if (e.plan.already) continue;
    for (const site of e.sites) { site.set(e.plan.url); changed++; }
}
const fixes = sourceLayerFixes(config);
for (const f of fixes) f.layer['source-layer'] = f.to;
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
console.log(`rewrote ${changed} URL(s) across ${planned.length} distinct services in ${file}`);
if (fixes.length) {
    console.log(`aligned ${fixes.length} source-layer name(s) with the published tile layer, e.g. ${fixes[0].from} → ${fixes[0].to}`);
}
console.log(`${blocked.length} URLs left unchanged — no rule yet. Run --plan to see them.`);
