'use strict';

const path = require('path');
const ErrorList = require('./error-list');
const Errors = require('./errors');
const AddonInfo = require('../addon-info');

/**
 * Class that stores information about a single package (directory tree with
 * a package.json and other data, like and Addon or Project.) It is one of the
 * two types of entries in a PackageInfoCache. It is only created by the
 * PackageInfoCache.
 *
 * @public
 * @class PackageInfo
 */
class PackageInfo {
  constructor(pkgObj, realPath, cache) {
    this.pkg = pkgObj;
    this.pkg['ember-addon'] = this.pkg['ember-addon'] || {};
    this.realPath = realPath;
    this.cache = cache;
    this.errors = new ErrorList();

    // other fields that will be set as needed. For JIT we'll define
    // them here.
    this.addonMainPath = undefined; // addons only
    this.inRepoAddons = undefined; // (list of PackageInfo - both)
    this.internalAddons = undefined; // (list of PackageInfo - project only)
    this.cliInfo = undefined; // (PackageInfo - project only)
    this.dependencyPackages = undefined; // (obj keyed by dependency name: PackageInfo)
    // NOTE: ALL dependencies, not just addons
    this.devDependencyPackages = undefined; // (obj keyed by devDependency name: PackageInfo)
    // NOTE: these are ALL dependencies, not just addons
    this.nodeModules = undefined; // (NodeModulesList, set only if pkg contains node_modules)

    // flag indicating that the packageInfo is considered valid. This will
    // be true as long as we have a valid directory and our package.json file
    // is okay and, if we're an ember addon, that we have a valid 'main' file.
    // Missing dependencies will not be considered an error, since they may
    // not actually be used.
    this.valid = true;

    this._hasDumpedInvalidAddonPackages = false;
  }

  // Make various fields of the pkg object available.
  get name() {
    return this.pkg.name;
  }

  /**
   * Given error data, add an ErrorEntry to the ErrorList for this object.
   * This is used by the _readPackage and _readNodeModulesList methods. It
   * should not be called otherwise.
   *
   * @protected
   * @method addError
   * @param {String} errorType one of the Errors.ERROR_* constants.
   * @param {Object} errorData any error data relevant to the type of error
   * being created. See showErrors().
   */
  addError(errorType, errorData) {
    this.errors.addError(errorType, errorData);
  }

  /**
   * Indicate if there are any errors in the ErrorList for this package. Note that this does
   * NOT indicate if there are any errors in the objects referred to by this package (e.g.,
   * internal addons or dependencies).
   *
   * @public
   * @method hasErrors
   * @param {boolean} true if there are errors in the ErrorList, else false.
   */
  hasErrors() {
    return this.errors.hasErrors();
  }

  /**
   * Add a reference to an in-repo addon PackageInfo object.
   *
   * @protected
   * @method addInRepoAddon
   * @param {PackageInfo} inRepoAddonPkg the PackageInfo for the in-repo addon
   * @return null
   */
  addInRepoAddon(inRepoAddonPkg) {
    if (!this.inRepoAddons) {
      this.inRepoAddons = [];
    }
    this.inRepoAddons.push(inRepoAddonPkg);
  }

  /**
   * Add a reference to an internal addon PackageInfo object.
   * "internal" addons (note: not in-repo addons) only exist in
   * Projects, not other packages. Since the cache is loaded from
   * 'loadProject', this can be done appropriately.
   *
   * @protected
   * @method addInternalAddon
   * @param {PackageInfo} internalAddonPkg the PackageInfo for the internal addon
   * @return null
   */
  addInternalAddon(internalAddonPkg) {
    if (!this.internalAddons) {
      this.internalAddons = [];
    }
    this.internalAddons.push(internalAddonPkg);
  }

  /**
   * For each dependency in the given list, find the corresponding
   * PackageInfo object in the cache (going up the file tree if
   * necessary, as in the node resolution algorithm). Return a map
   * of the dependencyName to PackageInfo object. Caller can then
   * store it wherever they like.
   *
   * Note: this is not to be  called until all packages that can be have
   * been added to the cache.
   *
   * Note: this is for ALL dependencies, not just addons. To get just
   * addons, filter the result by calling pkgInfo.isAddon().
   *
   * Note: this is only intended for use from PackageInfoCache._resolveDependencies.
   * It is not to be called directly by anything else.
   *
   * @protected
   * @method addDependencies
   * @param {PackageInfo} dependencies value of 'dependencies' or 'devDependencies'
   *        attributes of a package.json.
   * @return {Object} a JavaScript object keyed on dependency name/path with
   *    values the corresponding PackageInfo object from the cache.
   */
  addDependencies(dependencies) {
    if (!dependencies) {
      return null;
    }

    let dependencyNames = Object.keys(dependencies);

    if (dependencyNames.length === 0) {
      return null;
    }

    let packages = Object.create(null);

    let missingDependencies = [];

    dependencyNames.forEach(dependencyName => {
      let dependencyPackage;

      // much of the time the package will have dependencies in
      // a node_modules inside it, so check there first because it's
      // quicker since we have the reference. Only check externally
      // if we don't find it there.
      if (this.nodeModules) {
        dependencyPackage = this.nodeModules.findPackage(dependencyName);
      }

      if (!dependencyPackage) {
        dependencyPackage = this.cache._findPackage(
          dependencyName,
          path.dirname(this.realPath)
        );
      }

      if (dependencyPackage) {
        packages[dependencyName] = dependencyPackage;
      } else {
        missingDependencies.push(dependencyName);
      }
    });

    if (missingDependencies.length > 0) {
      this.addError(Errors.ERROR_DEPENDENCIES_MISSING, missingDependencies);
    }

    return packages;
  }

  isAddon() {
    let val =
      Array.isArray(this.pkg.keywords) &&
      this.pkg.keywords.indexOf('ember-addon') >= 0;
    return val;
  }

  /**
   * Add to a list of child addon PackageInfos for this packageInfo.
   *
   * @method addPackages
   * @param {Array} addonPackageList the list of child addon PackageInfos being constructed from various
   * sources in this packageInfo.
   * @param {Array | Object} packageInfoList a list or map of PackageInfos being considered
   * (e.g., pkgInfo.dependencyPackages) for inclusion in the addonPackageList.
   * @param {Function} excludeFn an optional function. If passed in, each child PackageInfo
   * will be tested against the function and only included in the package map if the function
   * returns a truthy value.
   */
  addPackages(addonPackageList, packageInfoList, excludeFn) {
    if (!packageInfoList) {
      return;
    }

    if (Array.isArray(packageInfoList)) {
      if (excludeFn) {
        packageInfoList = packageInfoList.filter(pkgInfo => !excludeFn(pkgInfo));
      }

      packageInfoList.forEach(pkgInfo => addonPackageList.push(pkgInfo));
    } else {
      // We're going to assume we have a map of name to packageInfo
      Object.keys(packageInfoList).forEach(name => {
        let pkgInfo = packageInfoList[name];
        if (!excludeFn || !excludeFn(pkgInfo)) {
          addonPackageList.push(pkgInfo);
        }
      });
    }

    return addonPackageList;
  }

  /**
   * Discover the child addons for this packageInfo, which corresponds to an Addon.
   *
   * @method discoverAddonAddons
   */
  discoverAddonAddons() {
    let addonPackageList = [];

    this.addPackages(addonPackageList,
      this.dependencyPackages, pkgInfo => !pkgInfo.isAddon() || pkgInfo.name === 'ember-cli');
    this.addPackages(addonPackageList, this.inRepoAddons);

    return addonPackageList;
  }

  /**
   * Discover the child addons for this packageInfo, which corresponds to a Project.
   *
   * @method discoverProjectAddons
   */
  discoverProjectAddons() {
    let project = this.project;

    let addonPackageList = [];

    this.addPackages(addonPackageList, (project.isEmberCLIAddon() ? [this] : null));
    this.addPackages(addonPackageList, (this.cliInfo ? this.cliInfo.inRepoAddons : null));
    this.addPackages(addonPackageList, this.internalAddons);
    this.addPackages(addonPackageList, this.dependencyPackages, pkgInfo => !pkgInfo.isAddon());
    this.addPackages(addonPackageList, this.devDependencyPackages, pkgInfo => !pkgInfo.isAddon());
    this.addPackages(addonPackageList, this.inRepoAddons);

    return addonPackageList;
  }

  /**
   * Given a list of PackageInfo objects, generate the 'addonPackages' object (keyed by
   * name, value = AddonInfo instance, for all packages marked 'valid'). This is stored in
   * both Addon and Project instances.
   *
   * @method generateAddonPackages
   * @param {Array} addonPackageList the list of child addon PackageInfos to work from
   * @param {Function} excludeFn an optional function. If passed in, each child PackageInfo
   * will be tested against the function and only included in the package map if the function
   * returns a truthy value.
   */
  generateAddonPackages(addonPackageList, excludeFn) {
    let validPackages = this.getValidPackages(addonPackageList);

    let packageMap = Object.create(null);

    validPackages.forEach(pkgInfo => {
      let addonInfo = new AddonInfo(pkgInfo.name, pkgInfo.realPath, pkgInfo.pkg);
      if (!excludeFn || !excludeFn(addonInfo)) {
        packageMap[pkgInfo.name] = addonInfo;
      }
    });

    return packageMap;
  }

  getValidPackages(addonPackageList) {
    return addonPackageList.filter(pkgInfo => pkgInfo.valid);
  }

  getInvalidPackages(addonPackageList) {
    return addonPackageList.filter(pkgInfo => !pkgInfo.valid);
  }

  dumpInvalidAddonPackages(addonPackageList) {
    if (this._hasDumpedInvalidAddonPackages) { return; }
    this._hasDumpedInvalidAddonPackages = true;

    let invalidPackages = this.getInvalidPackages(addonPackageList);

    let ui = this.cache.ui;

    if (invalidPackages.length > 0 && ui && ui.writeWarnLine) {
      let typeName = (this.project ? 'project' : 'addon');
      ui.writeWarnLine(`For ${typeName} at path ${this.realPath}:`);
      invalidPackages.forEach(packageInfo => {
        let relativePath = path.relative(this.realPath, packageInfo.realPath);
        ui.writeWarnLine(`   Excluding invalid/malformed/missing addon at relative path '${relativePath}'`);
      });
    }
  }

  /**
   * This is only supposed to be called by the addon instantiation code.
   * Also, the assumption here is that this PackageInfo really is for an
   * Addon, so we don't need to check each time.
   *
   * @method getAddonConstructor
   * @return {AddonConstructor} an instance of a constructor function for the Addon class
   * whose package information is stored in this object.
   */
  getAddonConstructor() {
    if (this.addonConstructor) {
      return this.addonConstructor;
    }

    // Load the addon.
    // TODO: Future work - allow a time budget for loading each addon and warn
    // or error for those that take too long.
    let module = require(this.addonMainPath);
    let mainDir = path.dirname(this.addonMainPath);

    let ctor;

    if (typeof module === 'function') {
      ctor = module;
      ctor.prototype.root = ctor.prototype.root || mainDir;
      ctor.prototype.pkg = ctor.prototype.pkg || this.pkg;
    } else {
      const Addon = require('../addon'); // done here because of circular dependency

      ctor = Addon.extend(
        Object.assign({ root: mainDir, pkg: this.pkg }, module)
      );
    }

    // XXX Probably want to store the timings here in PackageInfo,
    // rather than adding _meta_ to the constructor.
    // XXX Will also need to remove calls to it from various places.
    ctor._meta_ = {
      modulePath: this.addonMainPath,
      lookupDuration: 0,
      initializeIn: 0,
    };

    return (this.addonConstructor = ctor);
  }
}

module.exports = PackageInfo;
