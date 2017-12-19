'use strict'

var solc = require('solc/wrapper')
var solcABI = require('solc/abi')

var webworkify = require('webworkify')

var compilerInput = require('./compiler-input')

var remixLib = require('remix-lib')
var EventManager = remixLib.EventManager

var txHelper = require('../execution/txHelper')

/*
  trigger compilationFinished, compilerLoaded, compilationStarted, compilationDuration
  触发编译完成、编译完成、开始编译、编译中...
*/
function Compiler (handleImportCall) {
  var self = this
  this.event = new EventManager()

  var compileJSON

  var worker = null

  var currentVersion

  var optimize = false

  this.setOptimize = function (_optimize) {
    optimize = _optimize
  }

  var compilationStartTime = null
  this.event.register('compilationFinished', (success, data, source) => {
    if (success && compilationStartTime) {
      this.event.trigger('compilationDuration', [(new Date().getTime()) - compilationStartTime])
      // 获取到data之后调用ui/renderer api error()
    }
    compilationStartTime = null
  })

  this.event.register('compilationStarted', () => {
    compilationStartTime = new Date().getTime()
  })

  var internalCompile = function (files, target, missingInputs) {
    console.log('internalCompile',files, target, missingInputs)
    gatherImports(files, target, missingInputs, function (error, input) {
      // input:{ 'sources': files, 'target': target }
      if (error) {
        self.lastCompilationResult = null
        self.event.trigger('compilationFinished', [false, {'error': { formattedMessage: error, severity: 'error' }}, files])
      } else {
        compileJSON(input, optimize ? 1 : 0)
      }
    })
  }
  /*
   * files当前的文件内容
   * target当前的文件名
   */
  var compile = function (files, target) {
    console.info('编译触发2--定义')
    self.event.trigger('compilationStarted', [])
    // compilationStarted --> compilationStartTime = new Date().getTime()
    internalCompile(files, target)
    // gatherImports,
    // compileJSON,通过window.Module的compile方法将结果返回给 compilationFinished()
    // compilationFinished()-->触发 compilationFinished 事件
  }
  this.compile = compile

  function setCompileJSON (_compileJSON) {
    compileJSON = _compileJSON
  }
  this.setCompileJSON = setCompileJSON // this is exposed for testing

  function onCompilerLoaded (version) {
    currentVersion = version
    self.event.trigger('compilerLoaded', [version])
  }

  function onInternalCompilerLoaded () {
    // worker 初始值设了false，执行loadWorker赋值，此处没有执行
    if (worker === null) {
      var compiler = solc(window.Module)

      compileJSON = function (source, optimize, cb) {
        var missingInputs = []
        var missingInputsCallback = function (path) {
          missingInputs.push(path)
          return { error: 'Deferred import' }
        }

        var result
        try {
          // optimize setting面板中的Enable Optimization  默认不勾选为false
          var input = compilerInput(source.sources, {optimize: optimize, target: source.target})
          result = compiler.compileStandardWrapper(input, missingInputsCallback)
          result = JSON.parse(result)
        } catch (exception) {
          result = { error: 'Uncaught JavaScript exception:\n' + exception }
        }
        console.log('编译结果：', result)
        compilationFinished(result, missingInputs, source)
      }
      onCompilerLoaded(compiler.version())
    }
  }

  this.lastCompilationResult = {
    data: null,
    source: null
  }

  /**
    * return the contract obj of the given @arg name. Uses last compilation result.
    * return null if not found
    * @param {String} name    - contract name
    * @returns contract obj and associated file: { contract, file } or null
    */
  this.getContract = (name) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return txHelper.getContract(name, this.lastCompilationResult.data.contracts)
    }
    return null
  }

  /**
    * call the given @arg cb (function) for all the contracts. Uses last compilation result
    * @param {Function} cb    - callback
    */
  this.visitContracts = (cb) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return txHelper.visitContracts(this.lastCompilationResult.data.contracts, cb)
    }
    return null
  }

  /**
    * return the compiled contracts from the last compilation result
    * @return {Object}     - contracts
    */
  this.getContracts = () => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.contracts) {
      return this.lastCompilationResult.data.contracts
    }
    return null
  }

   /**
    * return the sources from the last compilation result
    * @param {Object} cb    - map of sources
    */
  this.getSources = () => {
    if (this.lastCompilationResult.source) {
      return this.lastCompilationResult.source.sources
    }
    return null
  }

  /**
    * return the sources @arg fileName from the last compilation result
    * @param {Object} cb    - map of sources
    */
  this.getSource = (fileName) => {
    if (this.lastCompilationResult.source) {
      return this.lastCompilationResult.source.sources[fileName]
    }
    return null
  }

  /**
    * return the source from the last compilation result that has the given index. null if source not found
    * @param {Int} index    - index of the source
    */
  this.getSourceName = (index) => {
    if (this.lastCompilationResult.data && this.lastCompilationResult.data.sources) {
      return Object.keys(this.lastCompilationResult.data.sources)[index]
    }
    return null
  }

  function compilationFinished (data, missingInputs, source) {
    var noFatalErrors = true // ie warnings are ok

    function isValidError (error) {
      // The deferred import is not a real error
      // FIXME: maybe have a better check?
      if (/Deferred import/.exec(error.message)) {
        return false
      }

      return error.severity !== 'warning'
    }

    if (data['error'] !== undefined) {
      // Ignore warnings (and the 'Deferred import' error as those are generated by us as a workaround
      if (isValidError(data['error'])) {
        noFatalErrors = false
      }
    }
    if (data['errors'] !== undefined) {
      data['errors'].forEach(function (err) {
        // Ignore warnings and the 'Deferred import' error as those are generated by us as a workaround
        if (isValidError(err)) {
          noFatalErrors = false
        }
      })
    }
    if (!noFatalErrors) {
      // There are fatal errors - abort here
      self.lastCompilationResult = null
      self.event.trigger('compilationFinished', [false, data, source])
    } else if (missingInputs !== undefined && missingInputs.length > 0) {
      // try compiling again with the new set of inputs
      internalCompile(source.sources, source.target, missingInputs)
    } else {
      data = updateInterface(data)

      self.lastCompilationResult = {
        data: data,
        source: source
      }
      self.event.trigger('compilationFinished', [true, data, source])
    }
  }

  this.loadVersion = function (usingWorker, url) {
    // 初始化函数 版本选择触发
    console.log('Loading ' + url + ' ' + (usingWorker ? 'with worker' : 'without worker'))
    self.event.trigger('loadingCompiler', [url, usingWorker])
    if (usingWorker) {
      loadWorker(url)
    } else {
      loadInternal(url)
      // 插入script文件,url=https://ethereum.github.io/solc-bin/bin/soljson-v0.4.17+commit.bdeb9e52.js  内部封装了window.Module
      // onInternalCompilerLoaded-->对compileJSON赋值，并执行 onCompilerLoaded (),
      // onCompilerLoaded 对version赋值，并触发 compilerLoaded 事件
      // compilerLoaded-->app.js,执行runCompiler()-->compiler.compile()
    }
  }

  function loadInternal (url) {
    delete window.Module
    // NOTE: workaround some browsers?
    window.Module = undefined

    // Set a safe fallback until the new one is loaded
    setCompileJSON(function (source, optimize) {
      compilationFinished({error: 'Compiler not yet loaded.'})
    })

    var newScript = document.createElement('script')
    newScript.type = 'text/javascript'
    newScript.src = url
    document.getElementsByTagName('head')[0].appendChild(newScript)
    var check = window.setInterval(function () {
      if (!window.Module) {
        return
      }
      window.clearInterval(check)
      onInternalCompilerLoaded()
    }, 200)
  }

  function loadWorker (url) {
    if (worker !== null) {
      worker.terminate()
    }
    worker = webworkify(require('./compiler-worker.js'))
    var jobs = []
    worker.addEventListener('message', function (msg) {
      var data = msg.data
      switch (data.cmd) {
        case 'versionLoaded':
          onCompilerLoaded(data.data)
          break
        case 'compiled':
          var result
          try {
            result = JSON.parse(data.data)
          } catch (exception) {
            result = { 'error': 'Invalid JSON output from the compiler: ' + exception }
          }
          var sources = {}
          if (data.job in jobs !== undefined) {
            sources = jobs[data.job].sources
            delete jobs[data.job]
          }
          compilationFinished(result, data.missingInputs, sources)
          break
      }
    })
    worker.onerror = function (msg) {
      compilationFinished({ error: 'Worker error: ' + msg.data })
    }
    worker.addEventListener('error', function (msg) {
      compilationFinished({ error: 'Worker error: ' + msg.data })
    })
    compileJSON = function (source, optimize) {
      jobs.push({sources: source})
      worker.postMessage({cmd: 'compile', job: jobs.length - 1, input: compilerInput(source.sources, {optimize: optimize, target: source.target})})
    }
    worker.postMessage({cmd: 'loadVersion', data: url})
  }

  function gatherImports (files, target, importHints, cb) {
    importHints = importHints || []

    // FIXME: This will only match imports if the file begins with one.
    //        It should tokenize by lines and check each.
    // eslint-disable-next-line no-useless-escape
    var importRegex = /^\s*import\s*[\'\"]([^\'\"]+)[\'\"];/g
    for (var fileName in files) {
      var match
      while ((match = importRegex.exec(files[fileName].content))) {
        var importFilePath = match[1]
        if (importFilePath.startsWith('./')) {
          var path = /(.*\/).*/.exec(target)
          if (path !== null) {
            importFilePath = importFilePath.replace('./', path[1])
          } else {
            importFilePath = importFilePath.slice(2)
          }
        }

        // FIXME: should be using includes or sets, but there's also browser compatibility..
        if (importHints.indexOf(importFilePath) === -1) {
          importHints.push(importFilePath)
        }
      }
    }

    while (importHints.length > 0) {
      var m = importHints.pop()
      if (m in files) {
        continue
      }

      handleImportCall(m, function (err, content) {
        if (err) {
          cb(err)
        } else {
          files[m] = { content }
          gatherImports(files, target, importHints, cb)
        }
      })

      return
    }

    cb(null, { 'sources': files, 'target': target })
  }

  function truncateVersion (version) {
    var tmp = /^(\d+.\d+.\d+)/.exec(version)
    if (tmp) {
      return tmp[1]
    }
    return version
  }

  function updateInterface (data) {
    txHelper.visitContracts(data.contracts, (contract) => {
      data.contracts[contract.file][contract.name].abi = solcABI.update(truncateVersion(currentVersion), contract.object.abi)
    })
    return data
  }
}

module.exports = Compiler
