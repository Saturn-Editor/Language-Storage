# Data & Storage for Saturn

A Saturn language module for data and storage files: JSON, YAML, TOML, XML, INI/.properties/.env,
CSV/TSV and SQL.

## Features

- **Syntax colouring** for every format. YAML, JSON, TOML, XML, INI and SQL use the standard
  TextMate scope names, so Markdown code fences (` ```yaml `, ` ```sql `, …) and YAML front matter
  are coloured too. CSV and TSV columns are coloured in rotation so columns are easy to follow.
- **Live preview**, rendered in your Saturn theme:
  - JSON, YAML, TOML and INI/.env/.properties as a collapsible tree (multiple YAML documents and
    JSON Lines records are listed separately);
  - XML as a collapsible element tree;
  - CSV/TSV as a table with row numbers and right-aligned numeric columns (the delimiter is detected);
  - SQL as a schema view of the tables, columns, keys, views and indexes from `CREATE` statements.

  If a file doesn't parse, the preview shows the error with its line and column and the
  surrounding source.
- **Completion** for keys already used in the document (JSON, YAML, TOML, INI), TOML tables and
  INI sections, `true`/`false`/`null`, XML element names and closing tags, and SQL keywords, types,
  functions, tables and columns (tables come from `CREATE TABLE` statements across the project's
  `.sql` files, and `alias.` completes that table's columns).
- **File templates** for JSON, YAML, TOML, XML, CSV and SQL files.

`tsconfig.json`, `jsconfig.json`, `.vscode/*.json`, `devcontainer.json` and `.jsonc` files are
read as JSON with comments; other `.json` files must be strict JSON.

## Installing

In Saturn, open **Marketplace → Languages → Install from folder…** and choose this folder.
No build or install step is needed; Saturn runs the completion server with its bundled runtime.

Requires Saturn module API `0.1`.

## Layout

| Path | Purpose |
| --- | --- |
| `saturn-module.json` | Manifest: what the module contributes |
| `module.js` | Registers the previews and file templates |
| `lib/json.js`, `yaml.js`, `toml.js`, `ini.js` | Parsers producing a shared data model (see `lib/common.js`) |
| `lib/xml.js`, `csv.js`, `sql.js` | XML parser, CSV parser, SQL tokenizer and schema reader |
| `lib/preview.js` | Preview HTML: trees, tables, schema and errors |
| `preview.css` | Preview styling, using Saturn's theme variables |
| `grammars/*.tmLanguage.json` | TextMate grammars for syntax colouring |
| `server/server.js` | Language server (completion) over stdio |
| `test/` | `npm test` (Node's built-in test runner); not included in releases |

The parsers have no dependencies. The YAML parser covers what configuration files use (block and
flow collections, all scalar styles, anchors, aliases, merge keys, tags and multiple documents)
but not complex `? key` mappings.

## Theme colours

Grammar scopes are written as a basic scope the built-in themes already colour, followed by the
conventional specific scope, e.g. `variable.other.property.json support.type.property-name.json`.
Saturn uses the innermost scope that has a theme rule, so a theme that styles
`support.type.property-name` will take over from the `variable` fallback.
