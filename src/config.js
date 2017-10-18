/*
 * @Author: liangyanxiang 
 * @Date: 2017-10-18 13:50:53 
 * @Last Modified by: liangyanxiang
 * @Last Modified time: 2017-10-18 13:53:15
 * Config 配置編輯器的设置 左右下界面模块的边界 打开的文件 是否为自动编译
 */

'use strict'

var CONFIG_FILE = '.remix.config'
function Config (storage) {
  this.items = {}

  // load on instantiation
  try {
    var config = storage.get(CONFIG_FILE)
    if (config) {
      this.items = JSON.parse(config)
    }
  } catch (exception) {
  }

  this.exists = function (key) {
    return this.items[key] !== undefined
  }

  this.get = function (key) {
    this.ensureStorageUpdated(key)
    return this.items[key]
  }

  this.set = function (key, content) {
    this.items[key] = content
    try {
      storage.set(CONFIG_FILE, JSON.stringify(this.items))
    } catch (exception) {
    }
  }

  this.ensureStorageUpdated = function (key) {
    if (key === 'currentFile') {
      if (this.items[key] && this.items[key] !== '' && this.items[key].indexOf('browser/') !== 0 && this.items[key].indexOf('localhost/') !== 0) {
        this.items[key] = 'browser/' + this.items[key]
      }
    }
  }
}

module.exports = Config
