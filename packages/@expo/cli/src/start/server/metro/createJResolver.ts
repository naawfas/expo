/**
 * Copyright © 2023 650 Industries.
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * Fork of the jest resolver but with additional settings for Metro and pnp removed.
 * https://github.com/jestjs/jest/blob/d1a2ed7fea4bdc19836274cd810c8360e3ab62f3/packages/jest-resolve/src/defaultResolver.ts#L1
 */
import type { JSONObject as PackageJSON } from '@expo/json-file';
import type { CustomResolutionContext } from '@expo/metro/metro-resolver';
import assert from 'assert';
import { dirname, isAbsolute, resolve as pathResolve } from 'path';
import { sync as resolveSync, SyncOpts as UpstreamResolveOptions } from 'resolve';
import * as resolve from 'resolve.exports';

/**
 * Allows transforming parsed `package.json` contents.
 *
 * @param pkg - Parsed `package.json` contents.
 * @param file - Path to `package.json` file.
 * @param dir - Directory that contains the `package.json`.
 *
 * @returns Transformed `package.json` contents.
 */
type PackageFilter = (pkg: PackageJSON, file: string, dir: string) => PackageJSON;

/**
 * Allows transforming a path within a package.
 *
 * @param pkg - Parsed `package.json` contents.
 * @param path - Path being resolved.
 * @param relativePath - Path relative from the `package.json` location.
 *
 * @returns Relative path that will be joined from the `package.json` location.
 */
type PathFilter = (pkg: PackageJSON, path: string, relativePath: string) => string;

// TODO(@kitten): This probably has overlap with an @expo/metro type
type ResolverOptions = {
  /** Directory to begin resolving from. */
  basedir: string;
  /** List of export conditions. */
  conditions?: string[];
  /** Instance of default resolver. */
  defaultResolver: typeof defaultResolver;
  /** List of file extensions to search in order. */
  extensions?: string[];
  /**
   * List of directory names to be looked up for modules recursively.
   *
   * @defaultValue
   * The default is `['node_modules']`.
   */
  moduleDirectory?: string[];
  /**
   * List of `require.paths` to use if nothing is found in `node_modules`.
   *
   * @defaultValue
   * The default is `undefined`.
   */
  paths?: string[];
  /** Allows transforming parsed `package.json` contents. */
  packageFilter?: PackageFilter;
  /** Allows transforms a path within a package. */
  pathFilter?: PathFilter;
  /** Current root directory. */
  rootDir?: string;

  enablePackageExports?: boolean;

  blockList: RegExp[];

  getPackageForModule: CustomResolutionContext['getPackageForModule'];
} & Pick<
  UpstreamResolveOptions,
  | 'readPackageSync'
  | 'realpathSync'
  | 'moduleDirectory'
  | 'extensions'
  | 'preserveSymlinks'
  | 'includeCoreModules'
>;

type UpstreamResolveOptionsWithConditions = UpstreamResolveOptions &
  ResolverOptions & {
    pathExists: (file: string) => boolean;
  };

const defaultResolver = (
  path: string,
  {
    enablePackageExports,
    blockList = [],
    ...options
  }: Omit<ResolverOptions, 'defaultResolver' | 'getPackageForModule'> & {
    isDirectory: (file: string) => boolean;
    isFile: (file: string) => boolean;
    pathExists: (file: string) => boolean;
  }
): string => {
  // @ts-expect-error
  const resolveOptions: UpstreamResolveOptionsWithConditions = {
    ...options,
    preserveSymlinks: options.preserveSymlinks,
    defaultResolver,
  };

  // resolveSync dereferences symlinks to ensure we don't create a separate
  // module instance depending on how it was referenced.
  const result = resolveSync(enablePackageExports ? getPathInModule(path, resolveOptions) : path, {
    ...resolveOptions,
    preserveSymlinks: !options.preserveSymlinks,
  });

  return result;
};

export default defaultResolver;

/*
 * helper functions
 */

function getPathInModule(path: string, options: UpstreamResolveOptionsWithConditions): string {
  if (shouldIgnoreRequestForExports(path)) {
    return path;
  }

  const segments = path.split('/');

  let moduleName = segments.shift();

  if (!moduleName) {
    return path;
  }

  if (moduleName.startsWith('@')) {
    moduleName = `${moduleName}/${segments.shift()}`;
  }

  // self-reference
  const closestPackageJson = findClosestPackageJson(options.basedir, options);
  if (closestPackageJson) {
    const pkg = options.readPackageSync!(options.readFileSync!, closestPackageJson);
    assert(pkg, 'package.json should be read by `readPackageSync`');

    // Added support for the package.json "imports" field (#-prefixed paths)
    if (path.startsWith('#')) {
      const resolved = resolve.imports(pkg, path, createResolveOptions(options.conditions));
      if (resolved) {
        // TODO: Should we attempt to resolve every path in the array?
        return pathResolve(dirname(closestPackageJson), resolved[0]);
      }
      // NOTE: resolve.imports would have thrown by this point.
      return path;
    }

    if (pkg.name === moduleName) {
      const resolved = resolve.exports(
        pkg,
        (segments.join('/') || '.') as resolve.Exports.Entry,
        createResolveOptions(options.conditions)
      );

      if (resolved) {
        return pathResolve(dirname(closestPackageJson), resolved[0]);
      }

      if (pkg.exports) {
        throw new Error(
          "`exports` exists, but no results - this is a bug in Expo CLI's Metro resolver. Report an issue: https://github.com/expo/expo/issues"
        );
      }
    }
  }

  let packageJsonPath = '';

  try {
    packageJsonPath = resolveSync(`${moduleName}/package.json`, options);
  } catch {
    // ignore if package.json cannot be found
  }

  if (!packageJsonPath) {
    return path;
  }

  const pkg = options.readPackageSync!(options.readFileSync!, packageJsonPath);
  assert(pkg, 'package.json should be read by `readPackageSync`');

  const resolved = resolve.exports(
    pkg,
    (segments.join('/') || '.') as resolve.Exports.Entry,
    createResolveOptions(options.conditions)
  );

  if (resolved) {
    return pathResolve(dirname(packageJsonPath), resolved[0]);
  }

  if (pkg.exports) {
    throw new Error(
      "`exports` exists, but no results - this is a bug in Expo CLI's Metro resolver. Report an issue: https://github.com/expo/expo/issues"
    );
  }

  return path;
}

function createResolveOptions(conditions: string[] | undefined): resolve.Options {
  return conditions
    ? { conditions, unsafe: true }
    : // no conditions were passed - let's assume this is Jest internal and it should be `require`
      { browser: false, require: true };
}

// if it's a relative import or an absolute path, imports/exports are ignored
const shouldIgnoreRequestForExports = (path: string) => path.startsWith('.') || isAbsolute(path);

// adapted from
// https://github.com/lukeed/escalade/blob/2477005062cdbd8407afc90d3f48f4930354252b/src/sync.js
function findClosestPackageJson(
  start: string,
  options: UpstreamResolveOptionsWithConditions
): string | undefined {
  let dir = pathResolve('.', start);
  if (!options.isDirectory!(dir)) {
    dir = dirname(dir);
  }

  while (true) {
    const pkgJsonFile = pathResolve(dir, './package.json');
    const hasPackageJson = options.pathExists!(pkgJsonFile);

    if (hasPackageJson) {
      return pkgJsonFile;
    }

    const prevDir = dir;
    dir = dirname(dir);

    if (prevDir === dir) {
      return undefined;
    }
  }
}
