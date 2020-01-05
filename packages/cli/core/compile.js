/**
 * Tencent is pleased to support the open source community by making WePY available.
 * Copyright (C) 2017 THL A29 Limited, a Tencent company. All rights reserved.
 *
 * Licensed under the MIT License (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at
 * http://opensource.org/licenses/MIT
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const parseOptions = require('./parseOptions');
const moduleSet = require('./moduleSet');
const CacheFile = require('./CacheFile');
const fileDep = require('./fileDep');
const logger = require('./util/logger');
const VENDOR_DIR = require('./util/const').VENDOR_DIR;
const Hook = require('./hook');
const tag = require('./tag');
const extTransform = require('./util/extTransform');
const { debounce } = require('throttle-debounce');

const initCompiler = require('./init/compiler');
const initParser = require('./init/parser');
const initPlugin = require('./init/plugin');

//const Chain = require('./compile/Chain');
const { AppChain, PageChain, ComponentChain, Chain } = require('./compile/chain');
const { Bead } = require('./compile/bead');
const Producer = require('./Producer');
const Resolver = require('./Resolver');
const Graph = require('./Graph');

class Compile extends Hook {
  constructor(opt) {
    super();

    this.version = require('../package.json').version;
    this.options = opt;

    if (!path.isAbsolute(opt.entry)) {
      this.options.entry = path.resolve(path.join(opt.src, opt.entry + opt.wpyExt));
    }

    this.resolvers = {};
    this.running = false;

    this.context = process.cwd();

    let appConfig = opt.appConfig || {};
    let userDefinedTags = appConfig.tags || {};

    this.tags = {
      htmlTags: tag.combineTag(tag.HTML_TAGS, userDefinedTags.htmlTags),
      wxmlTags: tag.combineTag(tag.WXML_TAGS, userDefinedTags.wxmlTags),
      html2wxmlMap: tag.combineTagMap(tag.HTML2WXML_MAP, userDefinedTags.html2wxmlMap)
    };

    this.logger = logger;

    this.cache = new CacheFile();
    this.producer = new Producer();
    this.graph = new Graph();

    const resolver = new Resolver(
      Object.assign({}, this.options.resolve, {
        extensions: ['.js', '.ts', '.json', '.node', '.wxs', this.options.wpyExt],
        mainFields: ['miniprogram', 'main']
      })
    );

    this.resolvers.weapp = {};

    ['script', 'style', 'template', 'config'].forEach(type => {
      const exts = [...new Set(this.options.weappRule[type].map(o => o.ext))];
      this.resolvers.weapp[type] = resolver.create({
        extensions: exts
      });
    });

    this.resolvers.normal = resolver.create();

    this.resolvers.context = resolver.create({
      resolveToContext: true
    });

    this.resolvers.normal.resolveSync = resolver.createSync();

    this.resolvers.context.resolveSync = resolver.createSync();
  }

  clear(type) {
    this.hook('process-clear', type);
    return this;
  }

  run() {
    return this.init().then(() => this.start());
  }

  init() {
    this.register('process-clear', () => {
      this.beads = {};
      this.vendors = new moduleSet();
      this.assets = new moduleSet();
      this.fileDep = new fileDep();
    });

    initParser(this);
    initPlugin(this);

    this.hook('process-clear', 'init');

    return initCompiler(this, this.options.compilers);
  }

  createAppChain(file) {
    const pathObj = path.parse(file);

    const bead = this.producer.make(Bead, path.join(pathObj.dir, pathObj.name));
    const chain = new AppChain(bead);

    return chain;
  }
  createPageChain(file) {
    const pathObj = path.parse(file);

    const bead = this.producer.make(Bead, path.join(pathObj.dir, pathObj.name));
    const chain = new PageChain(bead);

    return chain;
  }

  createComponentChain(file) {
    const pathObj = path.parse(file);

    const bead = this.producer.make(Bead, path.join(pathObj.dir, pathObj.name));
    const chain = new ComponentChain(bead);

    return chain;
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info('build app', 'start...');

    const chain = this.createAppChain(this.options.entry);

    //{ path: this.options.entry, type: 'app' })
    return this.hookUnique('make', chain)
      .then(chain => {
        const { bead, sfc } = chain;
        let config = sfc.config;

        let appConfig = config.bead.parsed.code.meta();
        if (!appConfig.pages || appConfig.pages.length === 0) {
          appConfig.pages = [];
          this.hookUnique('error-handler', {
            type: 'warn',
            chain,
            message: `Missing "pages" in App config`
          });
        }
        let pages = appConfig.pages.map(v => {
          return path.resolve(bead.path, '..', v);
        });

        if (appConfig.subPackages || appConfig.subpackages) {
          (appConfig.subpackages || appConfig.subPackages).forEach(sub => {
            sub.pages.forEach(v => {
              pages.push(path.resolve(bead.path, '../' + sub.root || '', v));
            });
          });
        }

        let tasks = pages.map(v => {
          let file;

          file = v + this.options.wpyExt;
          if (fs.existsSync(file)) {
            const pageChain = this.createPageChain(file);
            pageChain.root = chain;
            pageChain.setPrevious(chain);
            return this.hookUnique('make', pageChain);
          }
          file = v + '.js';
          if (fs.existsSync(file)) {
            const pageChain = this.createPageChain(file);
            pageChain.root = chain;
            pageChain.setPrevious(chain);
            return this.hookUnique('make', pageChain);
          }
          this.hookUnique('error-handler', {
            type: 'error',
            chain,
            message: `Can not resolve page: ${v}`
          });
        });

        if (appConfig.tabBar && appConfig.tabBar.custom) {
          let file = path.resolve(bead.path, '..', 'custom-tab-bar/index' + this.options.wpyExt);
          if (fs.existsSync(file)) {
            tasks.push(this.hookUnique('wepy-parser-wpy', { path: file, type: 'wepy' }));
          }
        }

        this.hookSeq('build-app', chain);
        this.hookUnique('output-app', chain);
        return Promise.all(tasks);
      })
      .then(this.buildComps.bind(this))
      .catch(this.handleBuildErr.bind(this));
  }

  buildComps(comps) {
    function buildComponents(comps) {
      if (!comps) {
        return Promise.resolve();
      }
      this.hookSeq('build-components', comps);
      this.hookUnique('output-components', comps);

      let tasks = [];

      comps.forEach(comp => {
        let config = comp.sfc.config || {};
        let parsed = config.bead.parsed || {};
        let parsedComponents = parsed.components || [];

        parsedComponents.forEach(comChain => {
          if (!comChain.ignore()) tasks.push(this.hookUnique('make', comChain));
        });
      });

      if (tasks.length) {
        return Promise.all(tasks).then(buildComponents.bind(this));
      } else {
        return Promise.resolve();
      }
    }

    return buildComponents
      .bind(this)(comps)
      .then(() => {
        let vendorData = this.hookSeq('build-vendor', {});
        this.hookUnique('output-vendor', vendorData);
      })
      .then(() => {
        let assetsData = this.hookSeq('build-assets');
        this.hookUnique('output-assets', assetsData);
      })
      .then(() => {
        return this.hookUnique('output-static');
      })
      .then(() => {
        this.hookSeq('process-done');
        this.running = false;
        this.logger.info('build', 'finished');
        if (this.options.watch) {
          this.logger.info('watching...');
          this.watch();
        }
      });
  }

  handleBuildErr(err) {
    this.running = false;
    if (err.message !== 'EXIT') {
      this.logger.error(err);
    }
    if (this.logger.level() !== 'trace') {
      this.logger.error('compile', 'Compile failed. Add "--log trace" to see more details');
    } else {
      this.logger.error('compile', 'Compile failed.');
    }
    if (this.options.watch) {
      this.logger.info('watching...');
      this.watch();
    }
  }

  watch() {
    if (this.watchInitialized) {
      return;
    }
    this.watchInitialized = true;
    let watchOption = Object.assign({ ignoreInitial: true, depth: 99 }, this.options.watchOption || {});
    // let target = path.resolve(this.context, this.options.target);

    if (watchOption.ignore) {
      let type = Object.prototype.toString.call(watchOption.ignore);
      if (type === '[object String]' || type === '[object RegExp]') {
        watchOption.ignored = [watchOption.ignored];
        watchOption.ignored.push(this.options.target);
      } else if (type === '[object Array]') {
        watchOption.ignored.push(this.options.target);
      }
    } else {
      watchOption.ignored = [this.options.target];
    }

    const pendingFiles = [];

    // debounce for watch files
    const onFileChanged = debounce(300, () => {
      const changedFiles = pendingFiles.splice(0, pendingFiles.length);
      if (changedFiles.length > 1) {
        // if more then one files changed, build the whole app.
        this.start();
      } else {
        const changedFile = changedFiles[0];
        const bead = this.producer.make(Bead, changedFile);
        const chain = new Chain(bead);
        const tasks = [];
        debugger;
        if (bead.chainType().app) {
          this.start();
        } else if (bead.chainType().page || bead.chainType().component) {
          tasks.push(this.hookUnique('make', chain));

          Promise.all(tasks)
            .then(this.buildComps.bind(this))
            .catch(this.handleBuildErr.bind(this));
        } else if (bead.chainType().assets) {
          tasks.push(this.hookUnique('make', chain));

          Promise.all(tasks)
            .then(() => this.buildComps(undefined))
            .catch(this.handleBuildErr.bind(this));
        } else {
          this.start();
        }
      }
    });

    chokidar.watch([this.options.src], watchOption).on('all', (evt, filepath) => {
      if (evt === 'change') {
        const file = path.resolve(filepath);
        if (!pendingFiles.includes(file)) {
          pendingFiles.push(file);
        }
        onFileChanged();
      }
    });
  }

  getTarget(file, targetDir) {
    let relative = path.relative(path.join(this.context, this.options.src), file);
    let targetFile = path.join(this.context, targetDir || this.options.target, relative);
    return targetFile;
  }

  getModuleTarget(file, targetDir) {
    let relative = path.relative(this.context, file);
    let dirs = relative.split(path.sep);
    dirs.shift(); // shift node_modules
    relative = dirs.join(path.sep);
    let targetFile = path.join(this.context, targetDir || this.options.target, VENDOR_DIR, relative);
    return targetFile;
  }
}

exports = module.exports = program => {
  const opt = parseOptions.parse(program);

  opt.weappRule = extTransform(opt.weappRule);

  const compilation = new Compile(opt);

  return compilation;
};
