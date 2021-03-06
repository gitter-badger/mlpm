'use strict';

var fs = require('fs')
  , path = require('path')
  , slash = require('slash')
  , vfs = require('vinyl-fs')
  , concat = require('concat-stream')
  , byline = require('byline')
  , async  = require('async')
  , _ = require('lodash')
  , mkdirp = require('mkdirp')
  , JSZip  = require('jszip')
  , rimraf = require('rimraf')
  , util = require('./util.js')

function readByLine(filePath, cb) {
  var fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    , lineStream = byline.createStream(fileStream)

  lineStream.on('data', function(line) {
    lineStream.pause()
    cb(line,
      function() { lineStream.resume() },
      function() { fileStream.destroy() })
  })
}

function xqyMetadata(filePath, cb) {
  var resourceNs = 'http://marklogic.com/rest-api/resource/'
    , transformNs = 'http://marklogic.com/rest-api/resource/'
    , moduleRegex = /^\s*module\s+namespace\s+[^\s=]+\s*=\s*"(.+)";\s*$/ // TODO: NCName regex for prefix
    , data = {}

  readByLine(filePath, function(line, resume, close) {
    // filePath is a main module if we've reached a namespace/variable/function declaration *before* a module declaration
    if ( /^\s*declare/.test( line ) || /^\s*for\s/.test( line ) || /^\s*let\s/.test( line ) ) {
      close()
      return cb(null, null)
    }

    if ( /^\s*module/.test( line ) ) {
      close()
      data.type = 'module'
      // TODO: try/catch
      data.ns = moduleRegex.exec( line )[1]

      if ( data.ns.indexOf( resourceNs ) > -1 ) {
        data.type = 'resource'
        data.name = data.ns.substring( data.ns.indexOf( resourceNs ) + resourceNs.length )
      } else if ( data.ns.indexOf( transformNs ) > -1 ) {
        data.type = 'transform'
        data.name = data.ns.substring( data.ns.indexOf( transformNs ) + transformNs.length )
      }

      return cb(null, data)
    }

    resume()
  })
}

function formatFromPath(filePath) {
  var format = 'txt'
    , extension = null

  if ( /\.[^\s\/]+$/.test( filePath ) ) {
    extension = /\.([^\s\/]+)$/.exec( filePath )[1]

    if ( ['xq', 'xqy', 'xql', 'xqm'].indexOf( extension ) > -1 ) {
      format = 'xqy'
    } else {
      format = extension
    }
  }

  return format
}

function getFileMetadata(filePath, deploy, cb) {
  var relativePath = filePath.replace(process.cwd() + path.sep, '')
    , metadata = {
        type: 'asset',
        path: filePath,
        relativePath: relativePath,
        format: formatFromPath(filePath),
        location: '/ext/' + slash(relativePath)
      }

  if ( !/^mlpm_modules/.test( metadata.relativePath ) ) return cb(
    new Error('Path parsing error: ' + JSON.stringify(metadata))
  )

  deploy = deploy || {}
  _.assign(metadata, deploy)

  var skipXqyCondition = false

  // TODO: confirm that metadata is valid without inspecting the file (performance enhancement)
  // ( metadata.format === 'xqy' ) ?
  // _.contains(['transform', 'resource'], data.type) && data.name

  if ( metadata.format === 'xqy' && !skipXqyCondition ) {
    return xqyMetadata(filePath, function(err, extractedMetadata) {
      if (err) return cb(err)

      if ( extractedMetadata ) {
        _.assign(metadata, extractedMetadata)
      }

      cb(null, metadata)
    })
  } else {
    process.nextTick(function() { cb(null, metadata) })
  }
}

function getFiles(name, excludes, cb) {
  var filePath = './mlpm_modules/' + name // path.resolve('mlpm_modules', name)
    , globs = [ filePath + '/**/*' ]

  if ( !cb ) {
    cb = excludes
    excludes = []
  }

  var defaultExcludes = [
    '/**/mlpm.json',
    '/**/CHANGELOG.md',
    '/**/README.md',
    '/**/README.mdown',
    '/**/LICENSE'
  ]

  _.chain(defaultExcludes)
  .union(excludes)
  .each(function(exclude) {
    globs.push( '!' + filePath + exclude )
  })
  .run()

  var src = vfs.src(globs, { read: false })

  src.on('error', cb)

  src.pipe(concat(function(files) {
    cb(null, _.chain(files)
      .filter(function(file) { return file.stat.isFile() })
      .map(function(file) { return file.path })
      .value()
    )
  }))
}

function parseDeployConfig(pkg) {
  var results = {}

  // TODO: capture relative path
  function absolutePath(relativePath) {
    return path.resolve('./mlpm_modules/' + pkg.name, relativePath)
  }

  if ( _.isArray( pkg.deploy ) && _.every( pkg.deploy, _.isObject ) ) {
    _.each( pkg.deploy, function(value) {
      var absPath = absolutePath( value.file )
      value.path = absPath
      results[ absPath ] = value
    })
  } else if ( _.isObject( pkg.deploy ) ) {
    _.each( pkg.deploy, function(value, file) {
      var absPath = absolutePath( file )
        , data = { path: absPath }

      if ( _.isObject(value) ) {
        _.assign(data, value)
      } else {
        data.type = value
      }

      results[ absPath ] = data
    })
  } else {
    // TODO: enable this ?
    // if ( _.isArray(pkg.deploy) && _.every(pkg.deploy, _.isString) )
    throw new Error('invalid deploy config')
  }

  return results
}

function parseContents(pkg, cb) {
  getFiles(pkg.name, function(err, paths) {
    if (err) return cb(err)

    var deploy = pkg.deploy ? parseDeployConfig(pkg) : {}

    async.map(paths,
      function(filePath, callback) {
        getFileMetadata(filePath, deploy[filePath], callback)
      },
      function(err, preparedDeploy) {
        if (err) return cb(err)

        pkg.preparedDeploy = _.sortBy(preparedDeploy, function(deploy) {
          var idx = ['resource', 'transform'].indexOf( deploy.type )
          return idx > -1 ? preparedDeploy.length : idx
        })

        cb(null, pkg)
      })
  })
}

function isInstalled(name, version, cb) {
  var packagePath = './mlpm_modules/' + name + '/mlpm.json'

  util.readJson(packagePath, function (err, pkgConfig) {
    if (err || pkgConfig.name !== name ) {
      return cb(null, false)
    }

    cb(null, true, pkgConfig)
  })
}

function saveFile(filePath, data, cb) {
  mkdirp(path.dirname(filePath), function (err) {
    if (err) return cb(err)
    fs.writeFile(filePath, data, cb)
  })
}

// TODO: remove? (this function was to optionally support nested installation)
function makePath(dir, filePath) {
  var saveNested = false
    , fullPath = ''

  if (saveNested) {
    fullPath = dir + filePath
  } else {
    fullPath = './mlpm_modules' + filePath
  }

  return fullPath
}

function install(buffer, obj, cb) {
  var zip = new JSZip(buffer)
    , files

  //TODO: rewrite path handling
  // var packagePath = path.resolve('mlpm_modules', obj.package)

  files = _.map(zip.files, function(contents, name) {
    var file = '/' + obj.package + '/' + name
    return { path: file, contents: contents.asText() }
  })

  // TODO delete package directory ?
  async.each(files, function(file, callback) {
    var filePath = makePath(obj.path, file.path)
    saveFile(filePath, file.contents, callback)
  }, function(err) {
    cb(err)
  })
}

function uninstall(name, cb) {
  rimraf( path.resolve('mlpm_modules', name), cb )
}

module.exports = {
  getFileMetadata: getFileMetadata,
  getFiles: getFiles,
  parseContents: parseContents,
  isInstalled: isInstalled,
  install: install,
  uninstall: uninstall
}
