/*!
 * import-aliases.js - Map aliases for each file.
 * Copyright (c) 2022, Nodari Chkuaselidze (MIT License)
 */

'use strict';

const path = require('path');


class FileInfo {
  constructor(filename) {
    this.filename = filename;
    // we are looking to resolve these.
    this.localImportAliases = new Map();

    this.longnamesByDeclaration = new Map();
    this.mappings = new Map();
    this.exports = new Map();
  }
}

const fileinfoByFile = new Map();

/**
 * Regex for import typedefs
 * Is not the best, but should be good enough.
 */


function getFileInfo(filename, getNew = false) {
  let fileinfo = fileinfoByFile.get(filename);

  if (!getNew) {
    return fileinfo;
  }

  if (fileinfo) {
    return fileinfo;
  }

  fileinfo = new FileInfo(filename);
  fileinfoByFile.set(filename, fileinfo);

  return fileinfo;
}

/**
 * Collect all `typedef imports` for a file
 * NOTE: It may modify e.source.
 * @param {JSDOCEvent} e
 */

function typedefImportAliases(e) {
  const filename = e.filename;
  const typedefRegex = /\/\*\*\s*?@typedef\s+\{import\(['"]([^'"]+)['"]\)*((?:\.\w+)*)\}\s+(\w+)\s*?\*\//g;
  const matchAll = [...e.source.matchAll(typedefRegex)];

  if (matchAll.length === 0) {
    return;
  }

  const fileinfo = getFileInfo(filename, true);

  for (const matched of matchAll) {
    const dir = path.dirname(filename);
    const file = withExt(path.resolve(dir, matched[1]));
    const exported = matched[2].slice(1);
    const localAlias = matched[3];

    // these will need resolving.
    fileinfo.localImportAliases.set(localAlias, [file, exported]);
  }

  e.source = e.source.replace(typedefRegex, '');
}

/**
 * Parse and resolve const .. = require aliases.
 */

function constSimpleRequireAliases(e) {
  const filename = e.filename;

  const simpleRequire = /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\)((?:\.\w+)*)\s*?;/g
  const simpleRequireAll = [...e.source.matchAll(simpleRequire)]

  if (simpleRequireAll.length === 0) {
    return;
  }

  const fileinfo = getFileInfo(filename, true);

  for (const matched of simpleRequireAll) {
    const dir = path.dirname(filename);
    const file = withExt(path.resolve(dir, matched[2]));
    const exported = matched[3].slice(1);
    const localAlias = matched[1];

    fileinfo.localImportAliases.set(localAlias, [file, exported]);
  }
}

/**
 * Parse and resolve const { .. } = require aliases.
 */

function constDestructRequireAliases(e) {
  const filename = e.filename;

  const destructRequire = /const\s+\{([^{}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\)((?:\.\w+)*)\s*?;/g
  const matchedAll = e.source.matchAll(destructRequire);
  const destructRequireAll = [...matchedAll]

  if (destructRequireAll.length === 0) {
    return;
  }

  const fileinfo = getFileInfo(filename, true);

  for (const matched of destructRequireAll) {
    const dir = path.dirname(filename);
    const file = withExt(path.resolve(dir, matched[2]));
    const exported = matched[3].slice(1);

    const exportedNames = matched[1].split(',').map(name => name.trim());

    for (const name of exportedNames) {
      const fullexport = exported ? exported + '.' + name : name;

      const localAlias = name;
      fileinfo.localImportAliases.set(localAlias, [file, fullexport]);
    }
  }
}

/**
 * Collect all import requests from the files and clean up import requests.
 * JSDOC Event handler.
 */

function beforeParse(e) {
  typedefImportAliases(e);
  constSimpleRequireAliases(e);
  constDestructRequireAliases(e);
}


function indexLongnames(fileinfo, doclet) {
  const {kind, name, longname, meta} = doclet;

  if (kind !== 'class' && kind !== 'function') {
    return;
  }

  const codename = meta.code.name;

  if (name !== longname) {
    fileinfo.longnamesByDeclaration.set(codename, longname);
    fileinfo.longnamesByDeclaration.set(name, longname);
  }
}

/**
 * Index every mapping that occured in the file.
 * @param {FileInfo} fileinfo
 * @param {Doclet} doclet
 */

function indexMappings(fileinfo, doclet) {
  const {kind, meta} = doclet;

  if (kind === 'class' || kind === 'function') {
    return;
  }

  if (meta.code.type !== 'Identifier') {
    return;
  }

  fileinfo.mappings.set(meta.code.name, meta.code.value);
}

/**
 * Finished generating new doclet, we can use the data from here to index
 * mappings and longname mappings.
 * JSDOC Event handler
 */

function newDoclet(e) {
  const {doclet} = e;;
  const {meta, scope} = doclet;
  const filename = path.resolve(meta.path, meta.filename);

  if (scope !== 'global' && scope !== 'static') {
    return;
  }

  const fileinfo = getFileInfo(filename, true);

  indexLongnames(fileinfo, doclet);
  indexMappings(fileinfo, doclet);
}

/**
 * Final index of the exports to prepare them for the imports.
 * @param {FileInfo} fileinfo
 */

function indexExports(fileinfo) {
  let moduleExports = null;
  let exportsAlias = 'exports';

  if (fileinfo.mappings.has('module.exports')) {
    moduleExports = fileinfo.mappings.get('module.exports');
    exportsAlias = moduleExports;
    const longname = fileinfo.longnamesByDeclaration.get(exportsAlias);

    if (longname) {
      fileinfo.exports.set('*', longname);
    }
  }

  for (const [key, value] of fileinfo.mappings.entries()) {
    if (value === 'exports') {
      exportsAlias = key;
    }
  }

  for (const [key, value] of fileinfo.mappings.entries()) {
    if (typeof key !== 'string') {
      continue;
    }

    if (key.startsWith(`${exportsAlias}.`)) {
      const exportKey = key.slice(exportsAlias.length + 1);
      const longname = fileinfo.longnamesByDeclaration.get(value);

      if (longname) {
        fileinfo.exports.set(exportKey, longname);
      }
    }
  }
}

/**
 * Find and replace all the imports.
 * @param {FileInfo} fileinfo
 */

function resolveImports(fileinfo) {
  const importAliases = fileinfo.localImportAliases;

  if (importAliases.size === 0)
    return;

  for (const [name, request] of importAliases) {
    const importFrom = getFileInfo(request[0]);

    if (!importFrom) {
      importAliases.set(name, null);
      continue;
    }

    const importName = request[1] || '*';
    const longname = importFrom.exports.get(importName);

    if (!longname) {
      importAliases.set(name, null);
      continue;
    }

    importAliases.set(name, longname);
  }
}

/**
 * Now we can reinject the resolved types info the importers.
 * @param {Doclet} doclet
 */

function modifyDoclet(doclet) {
  const {meta} = doclet;

  if (!meta) {
    return;
  }

  const filename = path.resolve(meta.path, meta.filename);
  const fileinfo = getFileInfo(filename);

  if (!fileinfo) {
    return;
  }

  const aliases = fileinfo.localImportAliases;
  const localNames = fileinfo.longnamesByDeclaration;

  const replaceTypes = (name) => {
    const typeMatch = /([\w\s,]+)(?:.<(.*)>)?$/;
    const match = name.match(typeMatch);

    if (!match) {
      throw new Error(`Error parsing ${meta.filename}:${meta.lineno}.`);
    }

    let actual = match[1].split(',').map(t => t.trim());
    const extra = match[2];

    actual = actual.map((t) => {
      if (localNames.has(t))
        return localNames.get(t);

      if (aliases.has(t))
        return aliases.get(t);

      return t;
    });

    actual = actual.join(', ');

    if (!extra) {
      return actual;
    }

    return `${actual}.<${replaceTypes(extra)}>`;
  };

  const replaceAllTypes = (type) => {
    if (!type) {
      return;
    }

    for (const [index, name] of type.names.entries()) {
      type.names[index] = replaceTypes(name);
    }
  };

  if (doclet.augments) {
    for (const [index, name] of doclet.augments.entries()) {
      doclet.augments[index] = replaceTypes(name);
    }
  }

  if (doclet.properties) {
    for (const property of doclet.properties) {
      replaceAllTypes(property.type);
    }
  }

  if (doclet.params) {
    for (const param of doclet.params) {
      replaceAllTypes(param.type);
    }
  }

  if (doclet.returns) {
    for (const returns of doclet.returns) {
      replaceAllTypes(returns.type)
    }
  }
}

/**
 * We have reached the end, we can finally index exports and
 * resolve exports.
 * JSDOC Event handler
 */

function processingComplete(e) {
  // finally try to reindex exports.
  // before we try to inject them as the imported aliases.
  for (const info of fileinfoByFile.values()) {
    indexExports(info);
  }

  // Now resolve imports
  for (const info of fileinfoByFile.values()) {
    resolveImports(info);
  }

  const {doclets} = e;

  for (const doclet of doclets) {
    modifyDoclet(doclet);
  }

  // disable generation for now.
  // e.doclets.length = 0;
}

/*
 * Helpers
 */

function withExt(file) {
  if (file.endsWith('.js')) {
    return file;
  }

  return file + '.js';
}

exports.handlers = {
  beforeParse,
  newDoclet,
  processingComplete
};
